import asynchandler from 'express-async-handler';
import Session from '../models/SessionModel.js';
import fetch from 'node-fetch';
import fs from 'fs';
import FormData from 'form-data';
import path from 'path';
import mongoose from 'mongoose';

const AI_SERVICE_URL = 'http://localhost:8000';

const pushSocketUpdate = (io, userId, sessionId, status, message, session = null) => {
    io.to(userId.toString()).emit('sessionUpdate', {
        sessionId,
        status,
        message,
        session,
    });
};


const createSession = asynchandler(async (req, res) => {
    const { role, level, interviewType, duration } = req.body;
    const userId = req.user._id;
    if (!role || !level || !interviewType || !duration) {
        res.status(400); // FIX: was req.status(400)
        throw new Error("Please fill all the fields");
    }
    let session = await Session.create({
        user: userId,
        role,
        level,
        interviewType,
        duration,
        status: "pending"
    });

    const io = req.app.get('io');

    res.status(201).json({
        message: "Session created successfully",
        sessionId: session._id,
        status: "processing"
    }); // FIX: semicolon added — without it, the IIFE below was parsed as a call on .json()'s return value

    (async () => {
        try {
            pushSocketUpdate(io, userId, session._id, 'Ai generating questions', `Generating questions for ${role}`);
            const aiResponse = await fetch(`${AI_SERVICE_URL}/generate-questions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role,
                    level,
                    count: 1,
                    interview_type: interviewType
                })
            });
            if (!aiResponse.ok) {
                const errorBody = await aiResponse.text();
                throw new Error(`AI Service error: ${aiResponse.status} - ${errorBody}`);
            }

            const aiData = await aiResponse.json();
            const codingCount = interviewType === 'coding-mix' ? 1 : 0;
            const questionsArray = aiData.questions.map((qText, index) => ({
                questionText: qText,
                questionType: index < codingCount ? 'coding' : 'oral',
                isEvaluated: false,
                isSubmitted: false,
            }));
            session.questions = questionsArray;
            session.status = 'in-progress';
            await session.save();
            pushSocketUpdate(io, userId, session._id, 'questions generated', 'Questions generated successfully start-session', session);

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
        .select('-questions.userSubmittedCode');
    res.json(session);
});

const getSessionById = asynchandler(async (req, res) => {
    const session = await Session.findOne({ _id: req.params.id, user: req.user._id });
    if (session) {
        res.json(session);
    } else {
        res.status(404);
        throw new Error("Session not found");
    }
});

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
});


const evaluateAnswerAsync = async (io, userId, sessionId, questionIndex, audioFilePath, codeSubmission) => {
    const processingStart = Date.now();
    let transcription = ""; // FIX: was `const` — cannot reassign a const
    const questionIdx = typeof questionIndex === 'string' ? parseInt(questionIndex, 10) : questionIndex;
    const session = await Session.findById(sessionId);
    if (!session) {
        console.error(`Session ${sessionId} not found`);
        return;
    }
    const question = session.questions[questionIdx];
    if (!question) {
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Question index ${questionIdx + 1} is out of bounds.`);
        return;
    }

    // Audio transcription
    if (audioFilePath) {
        try {
            pushSocketUpdate(io, userId, sessionId, 'AI_TRANSCRIBING', `Transcribing audio for Q${questionIdx + 1}...`);
            const formData = new FormData();
            formData.append('file', fs.createReadStream(audioFilePath));
            const transResponse = await fetch(`${AI_SERVICE_URL}/transcribe`, {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders()
            });
            if (!transResponse.ok) throw new Error('Transcription service failed');
            const transData = await transResponse.json();
            transcription = transData.transcription || "";
        } catch (error) {
            console.error(`Transcription Error: ${error.message}`);
        } finally {
            if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        }
    }

    // AI evaluation
    try {
        pushSocketUpdate(io, userId, sessionId, 'AI_EVALUATION', `AI is analyzing Q${questionIdx + 1}...`);
        const evalResponse = await fetch(`${AI_SERVICE_URL}/evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: question.questionText,
                question_type: question.questionType,
                role: session.role,
                level: session.level,
                user_answer: transcription,
                user_code: codeSubmission || "", // FIX: was `code` which was undefined
            }),
        });
        if (!evalResponse.ok) {
            throw new Error('AI Evaluation Service Failed!');
        }
        const evalData = await evalResponse.json();
        question.userAnswerText = transcription;
        question.userSubmittedCode = codeSubmission || ""; // FIX: was `code` which was undefined

        question.technicalScore = evalData.technicalScore;
        question.confidenceScore = evalData.confidenceScore;
        question.aiFeedback = evalData.aiFeedback;
        question.idealAnswer = evalData.idealAnswer;
        question.isEvaluated = true;

        if (session.status === 'completed') {
            const scoreSummary = await calculateOverallScore(sessionId);
            session.overallScore = scoreSummary.overallScore || 0;
            session.metrics = {
                avgTechnical: scoreSummary.avgTechnical,
                avgConfidence: scoreSummary.avgConfidence,
            };
            await session.save();
            pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Scores finalized.', session);
        } else {
            const timeElapsed = (new Date() - new Date(session.startTime)) / 60000;
            if (timeElapsed >= session.duration) {
                const scoreSummary = await calculateOverallScore(sessionId);
                session.overallScore = scoreSummary.overallScore || 0;
                session.metrics = { avgTechnical: scoreSummary.avgTechnical, avgConfidence: scoreSummary.avgConfidence };
                session.status = 'completed';
                session.endTime = new Date();
                await session.save();
                pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Time is up. Scores finalized.', session);
            } else {
                pushSocketUpdate(io, userId, sessionId, 'AI_GENERATING_QUESTIONS', 'Generating next adaptive question...');
                try {
                    const nextQResponse = await fetch(`${AI_SERVICE_URL}/generate-next-question`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            role: session.role,
                            level: session.level,
                            interview_type: session.interviewType,
                            previous_question: question.questionText,
                            user_answer: question.userAnswerText,
                            user_code: question.userSubmittedCode,
                            ai_feedback: question.aiFeedback
                        }),
                    });

                    if (nextQResponse.ok) {
                        const nextQData = await nextQResponse.json();
                        session.questions.push({
                            questionText: nextQData.question,
                            questionType: nextQData.questionType || 'oral',
                            isEvaluated: false,
                            isSubmitted: false,
                        });
                    }
                } catch (e) {
                    console.error("Failed to generate next question:", e);
                }

                if (session.lastPauseStart) {
                    const processingDuration = Date.now() - new Date(session.lastPauseStart).getTime();
                    session.pauseTimeMS = (session.pauseTimeMS || 0) + processingDuration;
                }
                session.isPaused = false;

                await session.save();
                pushSocketUpdate(io, userId, sessionId, 'NEW_QUESTION', `Feedback ready and new question available.`, session);
            }
        }

    } catch (error) {
        console.error(`Evaluation Error: ${error.message}`);
        session.isPaused = false;
        await session.save();
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Evaluation failed.`, session);
    }
};

const calculateOverallScore = async (sessionId) => {
    const results = await Session.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(sessionId) } },
        { $unwind: '$questions' },
        {
            $group: {
                _id: '$_id',
                avgTechnical: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.technicalScore', 0] }
                },
                avgConfidence: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.confidenceScore', 0] }
                }
            }
        },
        {
            $project: {
                _id: 0,
                overallScore: { $round: [{ $avg: ['$avgTechnical', '$avgConfidence'] }, 0] },
                avgTechnical: { $round: ['$avgTechnical', 0] },
                avgConfidence: { $round: ['$avgConfidence', 0] },
            }
        }
    ]);
    const finalResult = results[0] || { overallScore: 0, avgTechnical: 0, avgConfidence: 0 };
    const session = await Session.findById(sessionId);
    if (session && session.violations > 0) {
        const deductionPercent = Math.min(session.violations * 5, 80);
        const factor = (100 - deductionPercent) / 100;
        finalResult.overallScore = Math.round(finalResult.overallScore * factor);
    }
    return finalResult;
};

const endSession = asynchandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.user._id;
    const session = await Session.findById(sessionId);
    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
    if (session.status === 'completed') {
        res.status(400);
        throw new Error('Session is already completed.');
    }
    const scoreSummary = await calculateOverallScore(sessionId);

    session.overallScore = scoreSummary.overallScore || 0;
    session.status = 'completed';
    session.endTime = new Date();
    session.metrics = {
        avgTechnical: scoreSummary.avgTechnical,
        avgConfidence: scoreSummary.avgConfidence,
    };

    await session.save();

    const io = req.app.get('io');
    pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Interview session ended early.', session);

    res.json({ message: 'Session ended successfully.', session });
});

const startSession = asynchandler(async (req, res) => {
    const session = await Session.findById(req.params.id);

    if (!session || session.user.toString() !== req.user._id.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }

    if (!session.startTime) {
        session.startTime = new Date();
        session.status = 'in-progress';
        await session.save();
    }

    res.json(session);
});


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
    evaluateAnswerAsync(io, userId, sessionId, questionIdx, audioFilePath, codeSubmission);
});


export {
    createSession,
    getSessionById,
    getSessions,
    submitAnswer,
    endSession,
    calculateOverallScore,
    deleteSession,
    startSession
};