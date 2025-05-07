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
app.get("/api/jira/tickets/:ticketId", async (_, res) => {
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
app.get("/api/jira/release", async (req, res) => {
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

    // console.log('response.data', response.data);

    res.status(200).json(response.data)
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.error("Error status:", error.response.status)
      console.error("Error data:", error.response.data)

      if (error.response.status === 400) {
        res
          .status(400)
          .json({
            success: false,
            message: error.response.data.errorMessages[0],
          })
        return
      }
      if (error.response.status === 404) {
        res
          .status(404)
          .json({
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
app.post("/api/report", async (req, res) => {
  try {
    const body = req.body
    body.createdAt = new Date()
    body.reportedAt = new Date(body.reportedAt)

    const db = getDB()
    const collection = db.collection("reports")
    const result = await collection.insertOne(body)
    const _id = result.insertedId

    // 정규화 로직 추가
    const rawTimelineHealth = body.timelineHealth as string
    const parsedTimelineHealth = JSON.parse(
      rawTimelineHealth
    ) as ProjectFromFe[]

    const projectCollection = db.collection("projects")
    const featureCollection = db.collection("features")

    // 프로젝트별 처리
    for (const project of parsedTimelineHealth) {
      const { name, status, features } = project
      const team = body.team

      // 1. projects 컬렉션: 프로젝트명 저장/업데이트 (자동 제안을 위해)
      const projectResult = await projectCollection.updateOne(
        { "team.uid": team.uid, name }, // 팀 uid와 프로젝트 이름으로 고유성 보장
        [
          {
            $set: {
              name,
              team,
              status,
              lastUsedAt: body.reportedAt,
              createdAt: { $ifNull: ["$createdAt", new Date()] },
            },
          },
        ],
        {
          upsert: true, // 없으면 생성, 있으면 업데이트
        }
      )
      console.log("Project info updated: ", name)

      // 2. project_features 컬렉션: 날짜별 features 저장
      const projectDoc = await projectCollection.findOne({
        "team.uid": team.uid,
        name,
      })
      if (!projectDoc) {
        console.error("Project name not found: ", name)
        continue
      }

      // 동일 날짜(YYYY-MM-DD) 문서 확인 및 업데이트/삽입
      const startOfDay = new Date(body.reportedAt)
      startOfDay.setUTCHours(0, 0, 0, 0)

      const endOfDay = new Date(startOfDay)
      endOfDay.setUTCHours(23, 59, 59, 999)

      const featureResult = await featureCollection.updateOne(
        {
          // projectId, name, reportedAt(YYYY-MM-DD)로 고유성 보장
          projectId: projectDoc._id,
          reportedAt: { $gte: startOfDay, $lte: endOfDay },
        },
        {
          $set: {
            // 내용 변경
            features: {
              delta: JSON.stringify(features),
              normalized: parsedDeltaToFeatures(features),
            },
            reportedAt: body.reportedAt,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            // Create할 때 할당
            projectId: projectDoc._id,
            createdAt: new Date(),
          },
        },
        {
          upsert: true,
        }
      )

      console.log(
        "Features updated for:",
        name,
        startOfDay.toISOString().split("T")[0]
      )
    }

    res.status(200).json({ _id, message: "success" })
  } catch (error) {
    console.error("Error creating report:", error)

    res.status(500).json({ error: "Failed to create report" })
  }
})

// Update a report (Edit view)
app.put("/api/report/:uid", async (req, res) => {
  try {
    const { uid } = req.params
    const body = req.body
    body.reportedAt = new Date(body.reportedAt)
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

    // 정규화 로직 추가
    const rawTimelineHealth = body.timelineHealth as string
    const parsedTimelineHealth = JSON.parse(
      rawTimelineHealth
    ) as ProjectFromFe[]

    const projectCollection = db.collection("projects")
    const featureCollection = db.collection("features")

    // 프로젝트별 처리
    for (const project of parsedTimelineHealth) {
      const { name, status, features } = project
      const team = body.team

      // 1. projects 컬렉션: 프로젝트명 저장/업데이트 (자동 제안을 위해)
      const projectResult = await projectCollection.updateOne(
        { "team.uid": team.uid, name }, // 팀 uid와 프로젝트 이름으로 고유성 보장
        [
          {
            $set: {
              name,
              team,
              status,
              lastUsedAt: body.reportedAt,
              createdAt: { $ifNull: ["$createdAt", new Date()] },
            },
          },
        ],
        {
          upsert: true, // 없으면 생성, 있으면 업데이트
        }
      )
      console.log("Project info updated: ", name)

      // 2. project_features 컬렉션: 날짜별 features 저장
      const projectDoc = await projectCollection.findOne({
        "team.uid": team.uid,
        name,
      })
      if (!projectDoc) {
        console.error("Project name not found: ", name)
        continue
      }

      // 동일 날짜(YYYY-MM-DD) 문서 확인 및 업데이트/삽입
      const startOfDay = new Date(body.reportedAt)
      startOfDay.setUTCHours(0, 0, 0, 0)

      const endOfDay = new Date(startOfDay)
      endOfDay.setUTCHours(23, 59, 59, 999)

      const featureResult = await featureCollection.updateOne(
        {
          // projectId, name, reportedAt(YYYY-MM-DD)로 고유성 보장
          projectId: projectDoc._id,
          reportedAt: { $gte: startOfDay, $lte: endOfDay },
        },
        {
          $set: {
            // 내용 변경
            features: {
              delta: JSON.stringify(features),
              normalized: parsedDeltaToFeatures(features),
            },
            reportedAt: body.reportedAt,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            // Create할 때 할당
            projectId: projectDoc._id,
            createdAt: new Date(),
          },
        },
        {
          upsert: true,
        }
      )

      console.log(
        "Features updated for:",
        name,
        startOfDay.toISOString().split("T")[0]
      )
    }

    res.status(200).json({ _id: uid, message: "success" })
  } catch (error) {
    console.error("Error updating report:", error)

    res.status(500).json({ error: "Failed to update report" })
  }
})

// Get projects
app.get("/api/projects/search", async (req, res) => {
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

    res.status(200).json({ data: projects, message: "success" })
  } catch (error) {
    console.error("Error searching projects: ", error)

    res.status(500).json({ error: "Failed to search projects" })
  }
})

// Search projects
// app.get('/api/projects/search', async (req, res) => {
//   try {
//     const { q } = req.query

//     if (!q) {
//       res.status(400).json({ error: 'Missing query parameter' })
//       return
//     }

//     const db = getDB()
//     const collection = db.collection('projects')
//     const projects = await collection
//       .find({
//         name: { $regex: q, $options: 'i' }
//       })
//       .sort({ name: 1 })
//       .limit(100)
//       .toArray()

//     res.status(200).json({ data: projects, message: 'success' })
//   } catch (error) {
//     console.error('Error searching projects: ', error)

//     res.status(500).json({ error: 'Failed to search projects' })
//   }
// })

// Get a report by uid (Detail view)
app.get("/api/reports/:uid", async (req, res) => {
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
app.get("/api/teams", async (req, res) => {
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

// Get latest reports by reportedAt and teamId (max 5)
app.get("/api/reports", async (req, res) => {
  try {
    const { reportedAt, teamId } = req.query
    // console.log('Received query:', { reportedAt, teamId });

    if (!reportedAt || !teamId) {
      res.status(400).json({ error: "Missing reportedAt or teamId" })
      return
    }

    const db = getDB()
    const collection = db.collection("reports")

    const reportedAtDate = new Date(reportedAt as string)

    const result = await collection
      .find({
        "team.uid": teamId,
        reportedAt: { $lte: reportedAtDate }, // less than or equal to
      })
      .sort({ reportedAt: -1 }) // 최신 등록순
      .limit(5)
      .toArray()

    // console.log('Fetched reports:', result);

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

// Check if a report exists by teamId and reportedAt (Before Write view or Edit view)
app.get("/api/report", async (req, res) => {
  try {
    const { teamId, reportedAt } = req.query

    const startOfDay = new Date(reportedAt as string)
    startOfDay.setUTCHours(0, 0, 0, 0)

    const endOfDay = new Date(reportedAt as string)
    endOfDay.setUTCHours(23, 59, 59, 999)

    const db = getDB()
    const collection = db.collection("reports")

    // teamId와 reportedAt을 기준으로 리포트를 검색
    const result = await collection.findOne({
      "team.uid": teamId,
      reportedAt: {
        $gte: startOfDay,
        $lte: endOfDay,
      },
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

ViteExpress.listen(app, Number(process.env.PORT), async () => {
  await connectDB()
  console.log(`Server is listening on port ${process.env.PORT}...`)
})
