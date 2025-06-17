const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config();
const app = express();

// Configure CORS
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://fake-news-detector.vercel.app'
];

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Access-Control-Allow-Origin'],
    credentials: true,
    preflightContinue: true
}));

// Handle preflight requests
app.options('*', cors());

// Parse JSON bodies
app.use(express.json());

// Initialize Gemini AI
if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set in environment variables');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// MongoDB Connection
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            family: 4, // Force IPv4
        });
        console.log('Connected to MongoDB successfully');
        return true;
    } catch (err) {
        console.error('MongoDB connection error:', err.message);
        console.log('Running server without MongoDB - some features will be limited');
        return false;
    }
};

// News Schema
const newsSchema = new mongoose.Schema({
    content: String,
    title: String,
    isFake: Boolean,
    confidence: Number,
    features: [String],
    explanation: String,
    createdAt: { type: Date, default: Date.now }
});

const News = mongoose.model('News', newsSchema);

// Main analysis function using Gemini AI
async function analyzeText(title, content) {
    try {
        const prompt = `You are a fact-checking expert. Analyze this news article for authenticity.

        Title: ${title}
        Content: ${content}

        Analyze for:
        1. Factual accuracy
        2. Source credibility
        3. Language patterns
        4. Logical consistency
        5. Emotional manipulation
        6. Citation verification

        Return EXACTLY this JSON format (no other text):
        {
            "isFake": false,
            "confidence": 85,
            "features": ["finding 1", "finding 2"],
            "explanation": "detailed explanation"
        }

        Guidelines:
        - isFake must be true/false based on clear evidence
        - confidence must be 0-100 based on evidence strength
        - features must list specific findings
        - explanation must provide clear reasoning`;

        // Get Gemini's analysis with proper error handling
        const result = await model.generateContent(prompt);

        if (!result || !result.response) {
            throw new Error('No response received from AI service');
        }

        // Get response text and clean it
        const rawText = result.response.text().trim();
        console.log('Raw AI response:', rawText);

        // Find JSON object
        const jsonMatch = rawText.match(/{[\s\S]*}/);
        if (!jsonMatch) {
            console.error('Invalid response format:', rawText);
            throw new Error('Could not parse AI response');
        }

        // Parse and validate JSON
        const analysis = JSON.parse(jsonMatch[0]);

        // Strict validation of response format
        if (typeof analysis.isFake !== 'boolean') {
            throw new Error('Invalid analysis result');
        }
        if (typeof analysis.confidence !== 'number' || 
            analysis.confidence < 0 || 
            analysis.confidence > 100) {
            throw new Error('Invalid confidence score');
        }
        if (!Array.isArray(analysis.features) || analysis.features.length === 0) {
            throw new Error('No analysis features found');
        }
        if (typeof analysis.explanation !== 'string' || !analysis.explanation.trim()) {
            throw new Error('No explanation provided');
        }

        // Return validated analysis
        return {
            isFake: analysis.isFake,
            confidence: Math.round(analysis.confidence),
            features: analysis.features.map(f => f.trim()).filter(f => f),
            explanation: analysis.explanation.trim()
        };

    } catch (error) {
        console.error('Analysis error:', error.message);
        
        // Return a more descriptive error response
        return {
            isFake: false,
            confidence: 0,
            features: ['Error: Content analysis failed'],
            explanation: 'The analysis service is currently experiencing issues. Please wait a moment and try again.'
        };
    }
}

// Routes
app.post('/api/analyze', async (req, res) => {
    try {
        const { title, content } = req.body;
        
        if (!title?.trim() || !content?.trim()) {
            return res.status(400).json({ 
                error: 'Both title and content are required and cannot be empty' 
            });
        }

        if (content.length < 50) {
            return res.status(400).json({
                error: 'Content is too short. Please provide more text for accurate analysis.'
            });
        }

        const analysis = await analyzeText(title, content);

        // Check if analysis failed
        if (analysis.features?.[0]?.startsWith('Error:')) {
            return res.status(500).json({
                error: analysis.explanation || 'Analysis failed. Please try again.'
            });
        }

        // Save to database
        try {
            const newsEntry = new News({
                title,
                content,
                isFake: analysis.isFake,
                confidence: analysis.confidence,
                features: analysis.features,
                explanation: analysis.explanation
            });
            await newsEntry.save();
        } catch (dbError) {
            console.error('Database error:', dbError.message);
            // Continue even if save fails - don't block the response
        }

        res.json(analysis);
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ 
            error: 'Server error. Please try again later.',
            details: error.message 
        });
    }
});

// Get previous analyses
app.get('/api/history', async (req, res) => {
    try {
        const history = await News.find().sort({ createdAt: -1 }).limit(10);
        res.json(history);
    } catch (error) {
        res.json([]); // Return empty array if MongoDB is not available
    }
});

// Delete history item
app.delete('/api/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await News.findByIdAndDelete(id);
        
        if (!result) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json({ success: true, message: 'Item deleted successfully' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ 
            error: 'Failed to delete item',
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectDB();
});