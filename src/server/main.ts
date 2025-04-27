import express from "express";
import ViteExpress from "vite-express";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";
import { connectDB, getDB } from "./db.js";
dotenv.config();

const app = express();

app.use(cors({
  origin: 'http://localhost:5174',
}))

app.use(express.json()); // Ensure JSON body parsing middleware is used

app.get("/api/jira/tickets/:ticketId", async (_, res) => {
  const { ticketId } = _.params
  const domain = process.env.JIRA_DOMAIN
  const email = process.env.JIRA_EMAIL
  const apiToken = process.env.JIRA_API_TOKEN

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64")

  try {
    const response = await axios.get(`https://${domain}/rest/api/3/issue/${ticketId}`, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        "Accept-Language": "en",
      },
    });

    console.log('response.data', response.data)

    const summary = response.data.fields.summary
    const status = response.data.fields.status
    // const { summary, status } = response.data

    res.status(200).json({ summary, status })
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.log('Error status:', error.response.status);
      console.log('Error data:', error.response.data);
    }
    res.status(500).json({ error: "Failed to fetch ticket" })
  }
});

app.get("/api/jira/release", async (req, res) => {
  const { jql } = req.query as { jql: string };
  const domain = process.env.JIRA_DOMAIN;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  try {
    const encodedJql = encodeURIComponent(jql);
    const response = await axios.get(`https://${domain}/rest/api/3/search?jql=${encodedJql}`, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });

    console.log('response.data', response.data);

    res.status(200).json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.log('Error status:', error.response.status);
      console.log('Error data:', error.response.data);
    }
    res.status(500).json({ error: "Failed to fetch release data" });
  }
});

ViteExpress.listen(app, Number(process.env.PORT), async () => {
  await connectDB();
  console.log(`Server is listening on port ${process.env.PORT}...`);
});
