import asynchandler from 'express-async-handler';
import Session from '../models/Session.js';
import fetch from 'node-fetch';
import fs from 'fs';
import FormData from 'form-data';
import path from 'path';
import mongoose from 'mongoose';
import { resolveSoa } from 'dns';
const AI_SERVICE_URL = 'http://localhost:8000';

const pushSocketUpdate = (io, userId, sessionId, status, message, session = null) => {
    io.to(userId.toString()).emit('sessionUpdate', {
        sessionId,
        status,
        message,
        session,
    });
};


export const createSession = asynchandler(async (req, res) => {
    const { role, level, interviewType, duration } = req.body;
    const userId = req.user._id;
    if (!role || !level || !interviewType || !duration) {
        req.status(400);
        throw new Error("Please fill all the fields");
    }
    let session = await Session.create({
        user: userId,
        role,
        level,
        interviewType,
        duration,
        status: "pending"
    })
    const io = req.app.get('io');
    res.status(201).json({
        message: "Session created successfully",
        sessionId: session._id,
        status: "processing"
    })
        (async () => {
            try {
                pushSocketUpdate(io, userId, session._id, 'Ai generating questoins', `Generating questions for ${role}`)
                const aiResponse = await fetch(`${AI_SERVICE_URL}/generate-questions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        role,
                        level,
                        count: 1,
                        interview_type: interviewType
                    })
                })
                if (!aiResponse.ok) {
                    const errorBody = await aiResponse.text();
                    throw new Error(`AI Service error: ${aiResponse.status} - ${errorBody}`);
                }

                const aiData = await aiResponse.json();
                const codingCount = interviewType === 'coding-mix' ? 1 : 0
                const questionsArray = aiData.questions.map((qText, index) => ({
                    questionText: qText,
                    questionType: index < codingCount ? 'coding' : 'oral',
                    isEvaluated: false,
                    isSubmitted: false,
                }));
                session.questions = questionsArray;
                session.status = 'in-progress';
                await session.save();
                pushSocketUpdate(io, userId, session._id, 'questions generated', 'Questions generated successfully start-session', session)

            } catch (error) {
                console.error(`Session Creation Failure for ${session._id}:`, error.message);
                session.status = 'failed';
                await session.save();
                pushSocketUpdate(io, userId, session._id, 'GENERATION_FAILED', `Question generation failed. Reason: ${error.message}.`);
            }
        })();
});