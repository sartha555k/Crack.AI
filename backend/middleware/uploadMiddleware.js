import multer from 'multer';

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename(req, file, cb) {
        const ext = path.extname(file.originalname);
        const sessionId = req.params.id || 'unknown-session';

        cb(null, `${sessionId}-${Date.now()}${ext}`);
    }
})


const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
        cb(null, true);
    }
    else {
        cb(new Error('Invalid file type. Only audio files are allowed.'), false);
    }
}


const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 1024 * 1024 * 10 } // 10MB
})

const uploadSingleAudio = upload.single("audio");

export { uploadSingleAudio };




