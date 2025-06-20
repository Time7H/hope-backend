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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

app.use(cors())
app.use(express.json())

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true)
    } else {
      cb(new Error("Only audio files allowed"))
    }
  },
})

const messageQueue = []
const activeUsers = new Map()
const pendingReplies = new Map()
const userMessages = new Map()

function generateId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

function cleanupExpiredMessages() {
  const now = Date.now()
  for (let i = messageQueue.length - 1; i >= 0; i--) {
    if (now - messageQueue[i].timestamp > 60000) {
      const expiredMessage = messageQueue.splice(i, 1)[0]
      userMessages.delete(expiredMessage.id)
    }
  }
  for (const [messageId, data] of pendingReplies.entries()) {
    if (now - data.timestamp > 60000) {
      pendingReplies.delete(messageId)
    }
  }
}

setInterval(cleanupExpiredMessages, 10000)

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
    const senderId = req.body.senderId || "anonymous"

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
      senderId: senderId,
    }

    messageQueue.push(message)
    userMessages.set(messageId, senderId)

    console.log(`Message ${messageId} from ${senderId} added to queue. Queue length: ${messageQueue.length}`)

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

    let messageIndex = -1
    for (let i = 0; i < messageQueue.length; i++) {
      const message = messageQueue[i]
      const messageSenderId = userMessages.get(message.id)
      
      if (messageSenderId !== socket.id) {
        messageIndex = i
        break
      }
    }

    if (messageIndex !== -1) {
      const message = messageQueue.splice(messageIndex, 1)[0]
      userMessages.delete(message.id)

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
      console.log(`Message ${messageId} from user ${socket.id} processed`)
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
