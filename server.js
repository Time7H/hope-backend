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
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true)
    } else {
      cb(new Error("Only audio files allowed"))
    }
  },
})

// In-memory queue for user pairing
const messageQueue = []
const activeUsers = new Map()
const pendingReplies = new Map()

// Generate unique IDs
function generateId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

// Clean up expired messages
function cleanupExpiredMessages() {
  const now = Date.now()
  for (let i = messageQueue.length - 1; i >= 0; i--) {
    if (now - messageQueue[i].timestamp > 60000) {
      messageQueue.splice(i, 1)
    }
  }
  for (const [messageId, data] of pendingReplies.entries()) {
    if (now - data.timestamp > 60000) {
      pendingReplies.delete(messageId)
    }
  }
}

setInterval(cleanupExpiredMessages, 10000)

// API Routes
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeUsers: activeUsers.size,
    queueLength: messageQueue.length,
  })
})

app.post("/api/upload-message", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" })
    }

    const messageId = generateId()
    const fileName = `messages/${messageId}.wav`

    const { data, error } = await supabase.storage.from("audio-messages").upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    })

    if (error) {
      console.error("Supabase upload error:", error)
      return res.status(500).json({ error: "Failed to upload audio" })
    }

    const message = {
      id: messageId,
      fileName: fileName,
      timestamp: Date.now(),
      senderId: req.body.senderId || "anonymous",
    }

    messageQueue.push(message)

    if (messageQueue.length >= 2) {
      const message1 = messageQueue.shift()
      const message2 = messageQueue.shift()
      io.emit("message-paired", {
        message1: message1,
        message2: message2,
      })
    }

    res.json({
      success: true,
      messageId: messageId,
      queuePosition: messageQueue.length,
    })
  } catch (error) {
    console.error("Upload error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

app.get("/api/message/:messageId", async (req, res) => {
  try {
    const { messageId } = req.params
    const fileName = `messages/${messageId}.wav`

    const { data, error } = await supabase.storage.from("audio-messages").createSignedUrl(fileName, 300)

    if (error) {
      console.error("Supabase download error:", error)
      return res.status(404).json({ error: "Message not found" })
    }

    res.json({ audioUrl: data.signedUrl })
  } catch (error) {
    console.error("Download error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

app.post("/api/upload-reply", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" })
    }

    const replyId = generateId()
    const fileName = `replies/${replyId}.wav`
    const { originalMessageId, receiverId } = req.body

    const { data, error } = await supabase.storage.from("audio-messages").upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    })

    if (error) {
      console.error("Supabase reply upload error:", error)
      return res.status(500).json({ error: "Failed to upload reply" })
    }

    const replyInfo = {
      id: replyId,
      fileName: fileName,
      originalMessageId: originalMessageId,
      timestamp: Date.now(),
    }

    io.emit("reply-received", {
      replyId: replyId,
      originalMessageId: originalMessageId,
      fileName: fileName,
    })

    res.json({
      success: true,
      replyId: replyId,
    })
  } catch (error) {
    console.error("Reply upload error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  socket.on("join-queue", (userData) => {
    activeUsers.set(socket.id, {
      ...userData,
      joinedAt: Date.now(),
    })

    console.log(`User ${socket.id} joined queue. Active users: ${activeUsers.size}`)

    if (messageQueue.length > 0) {
      const message = messageQueue.shift()
      socket.emit("message-received", {
        messageId: message.id,
        fileName: message.fileName,
        timestamp: message.timestamp,
      })
      console.log(`Message ${message.id} sent to user ${socket.id}`)
    }
  })

  socket.on("send-message", async (data) => {
    try {
      const messageId = generateId()
      pendingReplies.set(messageId, {
        senderId: socket.id,
        timestamp: Date.now(),
      })
      socket.emit("message-sent", {
        messageId: messageId,
        timestamp: Date.now(),
      })
      console.log(`Message ${messageId} from user ${socket.id} added to queue`)
    } catch (error) {
      console.error("Send message error:", error)
      socket.emit("error", { message: "Failed to send message" })
    }
  })

  socket.on("send-reply", async (data) => {
    try {
      const { originalMessageId, replyId } = data
      const originalSender = pendingReplies.get(originalMessageId)
      if (originalSender) {
        io.to(originalSender.senderId).emit("reply-received", {
          replyId: replyId,
          originalMessageId: originalMessageId,
          timestamp: Date.now(),
        })
        pendingReplies.delete(originalMessageId)
        console.log(`Reply ${replyId} sent back to original sender`)
      }
      socket.emit("reply-sent", { success: true })
    } catch (error) {
      console.error("Send reply error:", error)
      socket.emit("error", { message: "Failed to send reply" })
    }
  })

  socket.on("skip-message", (data) => {
    console.log(`User ${socket.id} skipped message ${data.messageId}`)
    socket.emit("message-skipped", { success: true })
  })

  socket.on("disconnect", () => {
    activeUsers.delete(socket.id)
    console.log(`User ${socket.id} disconnected. Active users: ${activeUsers.size}`)
  })
})

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(`🚀 HOPE Backend Server running on port ${PORT}`)
  console.log(`📊 Health check: http://localhost:${PORT}/health`)
})

module.exports = { app, server }
