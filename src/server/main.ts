import express from "express"
import ViteExpress from "vite-express"
import dotenv from "dotenv"
import axios from "axios"
import cors from "cors"
import { connectDB, getDB } from "./db.js"
import { Filter, ObjectId, Document } from "mongodb"
import {
  parsedDeltaToFeatures,
  Project,
  ProjectFromFe,
} from "./utils/normalize.js"
dotenv.config()

const app = express()

app.use(
  cors({
    origin: ["http://localhost:5174", "https://gluwa.github.io"],
  })
)

app.use(express.json()) // Ensure JSON body parsing middleware is used

// Get ticket details
app.get("/api/v1/jira/tickets/:ticketId", async (_, res) => {
  const { ticketId } = _.params
  const domain = process.env.JIRA_DOMAIN
  const email = process.env.JIRA_EMAIL
  const apiToken = process.env.JIRA_API_TOKEN

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64")

  try {
    const response = await axios.get(
      `https://${domain}/rest/api/3/issue/${ticketId}`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Accept-Language": "en",
        },
      }
    )

    const summary = response.data.fields.summary
    const status = response.data.fields.status

    res.status(200).json({ summary, status })
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.error("Error status:", error.response.status)
      console.error("Error data:", error.response.data)
    }
    res.status(500).json({ error: "Failed to fetch ticket" })
  }
})

// Get release > ticket list (between startDate and endDate)
app.get("/api/v1/jira/release", async (req, res) => {
  const { jql } = req.query as { jql: string }
  const domain = process.env.JIRA_DOMAIN
  const email = process.env.JIRA_EMAIL
  const apiToken = process.env.JIRA_API_TOKEN

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64")

  try {
    const encodedJql = encodeURIComponent(jql)
    const response = await axios.get(
      `https://${domain}/rest/api/3/search?jql=${encodedJql}`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      }
    )

    res.status(200).json(response.data)
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.error("Error status:", error.response.status)
      console.error("Error data:", error.response.data)

      if (error.response.status === 400) {
        res.status(400).json({
          success: false,
          message: error.response.data.errorMessages[0],
        })
        return
      }
      if (error.response.status === 404) {
        res.status(404).json({
          success: false,
          message: error.response.data.errorMessages[0],
        })
        return
      }

      res.status(500).json({ error: error.response.data.errorMessages[0] })
    } else {
      console.error("Error:", error)
    }
  }
})

// Create report (Write view)
app.post("/api/v1/reports", async (req, res) => {
  try {
    const body = req.body
    body.createdAt = new Date()

    const db = getDB()
    const collection = db.collection("reports")
    const result = await collection.insertOne(body)
    const _id = result.insertedId

    res.status(200).json({ _id, message: "success" })
  } catch (error) {
    console.error("Error creating report:", error)

    res.status(500).json({ error: "Failed to create report" })
  }
})

// Update a report (Edit view)
app.put("/api/v1/reports/:uid", async (req, res) => {
  try {
    const { uid } = req.params
    const body = req.body
    body.updatedAt = new Date()

    const db = getDB()
    const collection = db.collection("reports")
    const result = await collection.updateOne(
      { _id: new ObjectId(uid) },
      { $set: body }
    )

    if (result.modifiedCount === 0) {
      res.status(404).json({ error: "Report not found" })
      return
    }

    res.status(200).json({ _id: uid, message: "success" })
  } catch (error) {
    console.error("Error updating report:", error)

    res.status(500).json({ error: "Failed to update report" })
  }
})

// Get all reports paginated by teamName, reportedAt(startDate, endDate)
app.get("/api/v1/reports", async (req, res) => {
  try {
    const { teamName, startDate, endDate, page = 0, limit = 15 } = req.query

    const db = getDB()
    const collection = db.collection("reports")

    let query: Filter<Document> = {}

    if (teamName) {
      if (typeof teamName === "string") {
        try {
          const decodedTeamNames = teamName.split(",").map(decodeURIComponent)
          query["team.name"] = { $in: decodedTeamNames }
        } catch (error) {
          console.error("Error decoding teamName: ", error)
          res.status(400).json({ error: "Invalid teamName format" })
          return
        }
      } else {
        res.status(400).json({ error: "Invalid teamName format" })
      }
    }

    if (startDate && endDate) {
      // 날짜 형식 검증 (YYYY-MM-DD)
      const datePattern = /^\d{4}-\d{2}-\d{2}$/
      if (
        !datePattern.test(startDate as string) ||
        !datePattern.test(endDate as string)
      ) {
        res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" })
        return
      }

      query.reportedAt = { $gte: startDate, $lte: endDate }
    }

    const pageNumber = parseInt(page as string, 10)
    const limitNumber = parseInt(limit as string, 10)

    if (isNaN(pageNumber) || isNaN(limitNumber)) {
      res.status(400).json({ error: "Invalid page or limit value" })
      return
    }

    const skip = pageNumber * limitNumber

    const result = await collection
      .find(query)
      .sort({ reportedAt: -1, "team.name": 1 })
      .skip(skip)
      .limit(limitNumber)
      .toArray()

    if (!result || result.length === 0) {
      res.status(404).json({ error: "No reports found" })
      return
    }

    const totalCount = await collection.countDocuments(query)

    res.status(200).json({
      data: result,
      pageInfo: {
        page: pageNumber,
        limit: limitNumber,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNumber),
      },
    })
  } catch (error) {
    console.error("Error searching projects: ", error)

    res.status(500).json({ error: "Failed to get projects" })
  }
})

// Get projects
app.get("/api/v1/projects/search", async (req, res) => {
  try {
    const { teamId, q } = req.query

    if (!teamId || !q) {
      res.status(400).json({ error: "Missing team or query parameters" })
      return
    }

    const db = getDB()
    const collection = db.collection("projects")

    let findQuery: Filter<Document> = { name: { $regex: q, $options: "i" } }
    if (teamId !== "*") {
      findQuery["team.uid"] = teamId
    }

    const projects = await collection
      .find(findQuery)
      .sort({ lastUsedAt: -1 })
      .limit(100)
      .toArray()

    const featuresCollection = db.collection("features")

    for (const project of projects) {
      const features = await featuresCollection
        .find({
          projectId: project._id,
        })
        .sort({ reportedAt: -1, "team.name": 1 })
        .limit(100)
        .toArray()

      project.features = features.reduce(
        (acc, feature) => {
          const delta = feature.features.delta
          const utcDate = new Date(feature.reportedAt)
          const localDate = new Date(
            utcDate.getTime() + utcDate.getTimezoneOffset() * -60 * 1000
          )
          const dateKey = localDate.toISOString().split("T")[0]

          acc[dateKey] = delta

          return acc
        },
        {} as Record<string, string>
      )
    }

    res.status(200).json({ data: projects, message: "success" })
  } catch (error) {
    console.error("Error searching projects: ", error)

    res.status(500).json({ error: "Failed to search projects" })
  }
})

// Get project names by teamId
app.get("/api/v1/projects/names", async (req, res) => {
  try {
    const teamId = req.query?.teamId
    const q = req.query.q

    if (!q) {
      res.status(400).json({ error: "Missing query value" })
      return
    }

    const db = getDB()
    const collection = db.collection("projects")

    let findQuery: Filter<Document> = { name: { $regex: q, $options: "i" } }
    if (teamId) {
      findQuery["team.uid"] = teamId
    }

    // TODO: 전체 팀 조회 시 Set 또는 MongoDB aggregation으로 중복 제거
    const projects = await collection
      .find(findQuery)
      .sort({ lastUsedAt: -1, name: 1 })
      .toArray()

    res.status(200).json({ data: projects, message: "success" })
  } catch (error) {
    console.error("Error searching projects: ", error)

    res.status(500).json({ error: "Failed to search projects" })
  }
})

// Check if a report exists by teamId and reportedAt (Before Write view or Edit view)
app.get("/api/v1/reports/previous", async (req, res) => {
  try {
    const { teamId, reportedAt } = req.query

    const db = getDB()
    const collection = db.collection("reports")

    // teamId와 reportedAt을 기준으로 리포트를 검색
    const result = await collection.findOne({
      "team.uid": teamId,
      reportedAt,
    })

    if (!result) {
      res.status(404).json({ error: "Report not found" })
      return
    }

    // 리포트가 존재할 경우 _id를 반환
    res.status(200).json({ data: result, message: "success" })
  } catch (error) {
    console.error("Error checking report:", error)
    res.status(500).json({ error: "Failed to check report" })
  }
})

// Get a report by uid (Detail view)
app.get("/api/v1/reports/:uid", async (req, res) => {
  try {
    const { uid } = req.params
    const db = getDB()
    const collection = db.collection("reports")
    const result = await collection.findOne({ _id: new ObjectId(uid) })

    if (!result) {
      res.status(404).json({ error: "Report not found" })
      return
    }

    res.status(200).json({ data: result, message: "success" })
  } catch (error) {
    console.error("Error fetching report:", error)

    res.status(500).json({ error: "Failed to fetch report" })
  }
})

// Get team list (Entry view)
app.get("/api/v1/teams", async (req, res) => {
  try {
    const db = getDB()
    const collection = db.collection("teams")
    const result = await collection.find({}).sort({ teamName: 1 }).toArray()

    res.status(200).json({ data: result, message: "success" })
  } catch (error) {
    console.error("Error fetching teams:", error)

    res.status(500).json({ error: "Failed to fetch teams" })
  }
})

// Get latest reports by reportedAt and teamId (max 5) - using at `Load previous reports` UI
app.get("/api/v1/teams/:teamId/reports", async (req, res) => {
  try {
    const { teamId } = req.params
    const { reportedAt } = req.query

    if (!reportedAt || !teamId) {
      res.status(400).json({ error: "Missing reportedAt or teamId" })
      return
    }

    // 날짜 형식 검증
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    if (typeof reportedAt !== "string" || !datePattern.test(reportedAt)) {
      res
        .status(400)
        .json({ error: "Invalid reportedAt format. Use YYYY-MM-DD" })
      return
    }

    const db = getDB()
    const collection = db.collection("reports")

    const result = await collection
      .find({
        "team.uid": teamId,
        reportedAt: { $lte: reportedAt }, // less than or equal to
      })
      .sort({ reportedAt: -1 })
      .limit(5)
      .toArray()

    if (!result || result.length === 0) {
      res.status(404).json({ error: "No reports found" })
      return
    }

    res.status(200).json({ data: result, message: "success" })
  } catch (error) {
    console.error("Error fetching reports:", error)

    res.status(500).json({ error: "Failed to fetch reports" })
  }
})

ViteExpress.listen(app, Number(process.env.PORT), async () => {
  await connectDB()
  console.log(`Server is listening on port ${process.env.PORT}...`)
})
