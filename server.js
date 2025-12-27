const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 读取提示词文件
async function readPromptFile(filename = 'default.txt') {
    try {
        const promptPath = path.join(__dirname, 'prompts', filename);
        const content = await fs.readFile(promptPath, 'utf-8');
        return content;
    } catch (error) {
        console.error('读取提示词文件失败:', error);
        return null;
    }
}

// 流式调用DeepSeek API
async function callDeepSeekAPIStream(messages, onData, onComplete) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error('DeepSeek API密钥未配置');
    }

    const url = 'https://api.deepseek.com/v1/chat/completions';
    
    const payload = {
        model: 'deepseek-chat',
        messages: messages,
        temperature: 0.7,
        max_tokens: 2000,
        stream: true
    };

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const response = await axios.post(url, payload, {
            headers: headers,
            responseType: 'stream'
        });

        let fullResponse = '';
        
        response.data.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    
                    if (data === '[DONE]') {
                        onComplete(fullResponse);
                        return;
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content || '';
                        
                        if (content) {
                            fullResponse += content;
                            onData(content);
                        }
                    } catch (error) {
                        console.error('解析流式数据失败:', error);
                    }
                }
            }
        });

        response.data.on('error', (error) => {
            console.error('流式响应错误:', error);
            onComplete(fullResponse, error);
        });

    } catch (error) {
        console.error('API调用失败:', error);
        throw error;
    }
}

// 普通调用DeepSeek API
async function callDeepSeekAPINormal(messages) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error('DeepSeek API密钥未配置');
    }

    const url = 'https://api.deepseek.com/v1/chat/completions';
    
    const payload = {
        model: 'deepseek-chat',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000,
        stream: false
    };

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    try {
        const response = await axios.post(url, payload, { headers });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('API调用失败:', error);
        throw error;
    }
}

// 分析用户意图
async function analyzeUserIntent(userFeedback, conversationHistory) {
    const prompt = `
请分析用户的最新反馈，判断用户是否要求继续对话或添加新需求。

对话历史上下文：
${conversationHistory}

用户最新反馈：
"${userFeedback}"

分析标准：
1. 如果用户表达了对当前推荐或提示词的【不满意】、【需要修改】、【有疑问】、【想要调整】等，则需要继续对话
2. 如果用户提出【新的需求】、【添加内容】、【补充信息】等，则需要继续对话
3. 如果用户只是表达【满意】、【认可】、【感谢】且没有新需求，则可以结束对话
4. 如果用户要求【更多】、【另外】、【还有】等内容，则需要继续对话

你的分析结果必须以以下JSON格式输出：
{
  "should_continue": true或false,
  "reason": "分析原因",
  "user_intent": "用户的意图描述",
  "continuation_type": "如果should_continue为true，说明是哪种类型的继续：'modification'表示修改需求，'addition'表示添加需求，'clarification'表示澄清需求"
}

请确保只输出JSON，不要有其他内容。
`;

    const messages = [
        {
            role: 'system',
            content: '你是一个专业的对话意图分析助手。请准确判断用户是否需要继续对话。'
        },
        {
            role: 'user',
            content: prompt
        }
    ];

    try {
        const response = await callDeepSeekAPINormal(messages);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return null;
    } catch (error) {
        console.error('分析用户意图失败:', error);
        return null;
    }
}

// 解析最终推荐结果
function parseFinalResponse(response) {
    try {
        const jsonMatch = response.match(/\{[^{}]*"model"[^{}]*"prompt"[^{}]*\}/gs);
        if (jsonMatch && jsonMatch.length > 0) {
            const jsonStr = jsonMatch[jsonMatch.length - 1]
                .replace(/\n/g, ' ')
                .replace(/\r/g, '')
                .trim();
            
            const data = JSON.parse(jsonStr);
            if (data.model && data.prompt) {
                return data;
            }
        }
        return null;
    } catch (error) {
        console.error('解析推荐结果失败:', error);
        return null;
    }
}

// 会话管理
const sessions = new Map();

// API路由

// 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 开始新会话
app.post('/api/session/start', async (req, res) => {
    try {
        const { userTask } = req.body;
        
        if (!userTask) {
            return res.status(400).json({ error: '用户任务不能为空' });
        }

        // 读取提示词
        const initialPrompt = await readPromptFile();
        if (!initialPrompt) {
            return res.status(500).json({ error: '无法读取提示词模板' });
        }

        // 创建会话
        const sessionId = Date.now().toString();
        const conversationHistory = `用户初始任务: ${userTask}\n`;
        
        const messages = [
            {
                role: 'system',
                content: '你是一个专业的AI模型推荐和提示词优化助手。请严格按照用户提供的提示词模板进行工作，确保输出格式正确。'
            },
            {
                role: 'user',
                content: `${initialPrompt}\n\n用户任务：\n${userTask}`
            }
        ];

        sessions.set(sessionId, {
            messages,
            conversationHistory,
            userTask,
            iterationCount: 1,
            recommendations: []
        });

        res.json({ 
            sessionId,
            message: '会话创建成功',
            iterationCount: 1
        });

    } catch (error) {
        console.error('创建会话失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 获取AI推荐（流式）
app.post('/api/recommend/stream', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId || !sessions.has(sessionId)) {
        return res.status(400).json({ error: '无效的会话ID' });
    }

    const session = sessions.get(sessionId);
    
    // 设置SSE头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        await callDeepSeekAPIStream(
            session.messages,
            // 数据回调
            (data) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', content: data })}\n\n`);
            },
            // 完成回调
            async (fullResponse, error) => {
                if (error) {
                    res.write(`data: ${JSON.stringify({ type: 'error', message: 'API调用失败' })}\n\n`);
                    res.end();
                    return;
                }

                // 将AI回复添加到消息历史
                session.messages.push({
                    role: 'assistant',
                    content: fullResponse
                });

                // 更新对话历史
                session.conversationHistory += `\n第${session.iterationCount}轮AI回复摘要: ${fullResponse.substring(0, 200)}...\n`;

                // 解析推荐结果
                const recommendation = parseFinalResponse(fullResponse);
                if (recommendation) {
                    session.recommendations.push(recommendation);
                }

                res.write(`data: ${JSON.stringify({ 
                    type: 'complete', 
                    fullResponse,
                    recommendation,
                    iterationCount: session.iterationCount
                })}\n\n`);
                res.end();
            }
        );

    } catch (error) {
        console.error('流式推荐失败:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: '请求失败' })}\n\n`);
        res.end();
    }
});

// 分析用户反馈
app.post('/api/analyze/feedback', async (req, res) => {
    try {
        const { sessionId, userFeedback } = req.body;
        
        if (!sessionId || !sessions.has(sessionId)) {
            return res.status(400).json({ error: '无效的会话ID' });
        }

        if (!userFeedback) {
            return res.status(400).json({ error: '用户反馈不能为空' });
        }

        const session = sessions.get(sessionId);

        // 分析用户意图
        const intentAnalysis = await analyzeUserIntent(userFeedback, session.conversationHistory);
        
        if (intentAnalysis) {
            // 更新对话历史
            session.conversationHistory += `\n第${session.iterationCount}轮用户反馈: ${userFeedback}\n`;
            
            if (intentAnalysis.should_continue) {
                // 需要继续对话
                const continuationType = intentAnalysis.continuation_type || 'addition';
                let feedbackMessage = '';

                if (continuationType === 'modification') {
                    feedbackMessage = `用户对之前的推荐提出了修改意见："${userFeedback}"\n\n用户意图：${intentAnalysis.user_intent}\n\n请根据用户的修改意见，重新优化推荐方案。`;
                } else if (continuationType === 'clarification') {
                    feedbackMessage = `用户需要澄清或解释："${userFeedback}"\n\n用户意图：${intentAnalysis.user_intent}\n\n请先解答用户的疑问，然后根据澄清后的需求重新优化推荐。`;
                } else {
                    feedbackMessage = `用户提出了新的需求或补充要求："${userFeedback}"\n\n用户意图：${intentAnalysis.user_intent}\n\n请综合考虑用户的原始任务和这个新需求，重新优化推荐方案。`;
                }

                // 添加用户反馈到消息中
                session.messages.push({
                    role: 'user',
                    content: feedbackMessage
                });

                session.iterationCount++;
                session.conversationHistory += `用户意图: ${intentAnalysis.user_intent} (类型: ${continuationType})\n`;

                res.json({
                    shouldContinue: true,
                    analysis: intentAnalysis,
                    iterationCount: session.iterationCount,
                    message: '将根据反馈进行优化'
                });

            } else {
                // 用户满意，结束对话
                res.json({
                    shouldContinue: false,
                    analysis: intentAnalysis,
                    message: '用户满意，可以结束对话'
                });
            }
        } else {
            // 分析失败，默认继续对话
            res.json({
                shouldContinue: true,
                message: '将根据反馈进行优化'
            });
        }

    } catch (error) {
        console.error('分析用户反馈失败:', error);
        res.status(500).json({ error: '分析失败' });
    }
});

// 获取会话历史
app.get('/api/session/:id', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions.has(sessionId)) {
        return res.status(404).json({ error: '会话不存在' });
    }

    const session = sessions.get(sessionId);
    res.json({
        sessionId,
        userTask: session.userTask,
        iterationCount: session.iterationCount,
        recommendations: session.recommendations,
        conversationHistory: session.conversationHistory
    });
});

// 导出推荐结果
app.get('/api/export/:sessionId', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions.has(sessionId)) {
        return res.status(404).json({ error: '会话不存在' });
    }

    const session = sessions.get(sessionId);
    const finalRecommendation = session.recommendations[session.recommendations.length - 1] || {};
    
    res.json({
        sessionId,
        userTask: session.userTask,
        finalRecommendation,
        allRecommendations: session.recommendations,
        conversationHistory: session.conversationHistory,
        iterationCount: session.iterationCount,
        exportTime: new Date().toISOString()
    });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`请确保已配置环境变量 DEEPSEEK_API_KEY`);
});