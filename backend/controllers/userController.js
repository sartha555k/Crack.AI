import asynchandler from 'express-async-handler';
import User from '../models/userModel.js';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { use } from 'react';

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1d' })
}

export const registerUser = asynchandler(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        res.status(400);
        throw new Error('Please fill all the fields');
    }
    const userExists = await User.findOne({ email });
    if (userExists) {
        res.status(400);
        throw new Error('User already exists');
    }
    const user = await User.create({
        name, email, password
    })
    if (user) {
        res.status(201).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            token: generateToken(user._id)
        })
    }
    else {
        res.status(400);
        throw new Error('Invalid user data');
    }
})

const loginUser = asynchandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        res.status(400);
        throw new Error("Please fill all the sections")
    }
    const user = await User.findOne({ email });
    if (user && await user.matchPassowrd(password)) {
        res.json({
            _id: user._id,
            email: user.email,
            name: user.name,
            preferredRole: user.preferredRole,
            token: generateToken(user._id)
        })
    }
    else {
        res.status(400);
        throw new Error("Invalid email or password");
    }
})


const googleLogin = asynchandler(async (req, res) => {
    const { token } = req.body;
    const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
    })
    const { email_verified, name, email, sub: gooledId } = ticket.getPayload();
    if (!email_verified) {
        res.status(400);
        throw new Error("Google account not verified");
    }
    const user = await User.findOne({ email });
    if (user) {
        if (!user.gooledId) {
            user.gooledId = gooledId;
            await user.save();
        }
    } else {
        const newUser = await User.create({
            name, email, gooledId, password: null
        })
        if (newUser) {
            res.status(201).json({
                _id: newUser._id,
                name: newUser.name,
                email: newUser.email,
                token: generateToken(newUser._id)
            })
        }
    }
})

const userProfile = asynchandler(async (req, res) => {
    if (req.user) {
        res.json({
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email,
            preferredRole: req.user.preferredRole,
            token: generateToken(req.user._id)
        })
    } else {
        res.status(404);
        throw new Error("User not found");
    }
})


const updateUserProfile = asynchandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    if (user) {
        user.name = req.body.name || user.name;
        user.email = req.body.email || user.email;
        user.preferredRole = req.body.preferredRole || user.preferredRole;
        if (req.body.password) {
            user.password = req.body.password;
        }
        await user.save();
        res.json({
            _id: user._id,
            name: user.name,
            email: user.email,
            preferredRole: user.preferredRole,
            token: generateToken(user._id)
        })
    } else {
        res.status(404);
        throw new Error("User not found");
    }
})

export { loginUser, googleLogin, userProfile, updateUserProfile }