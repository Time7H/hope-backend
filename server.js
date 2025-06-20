const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const cors = require("cors")
const multer = require("multer")
const { createClient } = require("@supabase/supabase-js")
require("dotenv").config()

const app = express()
const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

// Supabase setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// Middleware
app.use(cors())
app.use(express.json())

// Configure multer for audio uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSiz
