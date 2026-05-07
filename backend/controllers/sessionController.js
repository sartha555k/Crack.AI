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

const getSessions = asynchandler(async (req, res) => {
    const session = await Session.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .select('questions.userAnswerText -questions.userSubmittedCode')
    res.json(session);
})

const getSessionById = asynchandler(async (req, res) => {
    const session = await Session.findOne({ _id: req.params.id, user: req.user._id })
    if (session) {
        res.json(session);
    }
    else {
        res.status(404);
        throw new Error("Session not found");
    }
})

const deleteSession = asynchandler(async (req, res) => {
    const session = await Session.findById(req.params.id);
    if (!session) {
        res.status(404);
        throw new Error("Session not found");
    }
    if (session.user.toString() !== req.user._id.toString()) {
        res.status(401);
        throw new Error("Not authorized to delete this session");
    }
    await session.deleteOne();
    res.status(200).json({ id: req.params.id });
})

const submitAnswer = asynchandler(async (req, res) => {
    const sessionId = req.params.id;
    const { questionIndex, code, violations } = req.body;
    const userId = req.user._id;
    const session = await Session.findById(sessionId);
    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
    const questionIdx = parseInt(questionIndex, 10);
    const question = session.questions[questionIdx];
    if (!question) {
        res.status(400);
        throw new Error('Invalid question index.');
    }
    let audioFilePath = null;
    if (req.file) {
        audioFilePath = path.join(process.cwd(), req.file.path);
    }

    const codeSubmission = code || null;
    question.isSubmitted = true;
    session.isPaused = true;
    session.lastPauseStart = new Date();
    if (violations !== undefined) {
        session.violations = Number(violations);
    }

    await session.save();

    res.status(202).json({
        message: 'Answer received. Timer frozen locally and on server.',
        status: 'received',
        session
    });
    const io = req.app.get('io');
    evaluateAnswerAsync(io, userId, session, questionIdx, audioFilePath, codeSubmission);
})


export { createSession };