import express from 'express';
import dotenv from 'dotenv';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import connectDB from './config/db.js';
// import userRoutes from './routes/userRoutes.js';
// import sessionRoutes from './routes/sessionRoutes.js';
// import { notFound, errorHandler } from './middleware/errorMiddleware.js';


dotenv.config();
// hello world

const app = express();
const server = http.createServer(app);

connectDB();

const allowedOrigins = [
    'http://localhost:5174',
    'http://localhost:5173',
]

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        credentials: true,
        allowedHeaders: { 'content-type': 'Authorization' },
    }
})

app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
    allowedHeaders: { 'content-type': 'Authorization' },

}))

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('io', io);

app.get('/', (req, res) => {
    res.send('API is running');
})
// app.use('/api/users', userRoutes);
// app.use('/api/sessions', sessionRoutes);


io.on('connection', (socket) => {
    console.log(`New user connected ${socket.id}`)
    const userId = socket.handshake.query.userId;
    if (userId) {
        socket.join(userId);
        console.log(`User joined room ${userId}`);
    }
    socket.on('disconnect', () => {
        console.log(`User disconnected ${socket.id}`)
    })

});

// app.use(notFound);
// app.use(errorHandler);

const PORT = process.env.PORT || 5000;
server.listen(PORT,
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`)
)


