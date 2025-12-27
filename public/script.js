class AIGuideApp {
    constructor() {
        this.sessionId = null;
        this.currentIteration = 0;
        this.currentModel = '-';
        this.currentStatus = '等待输入任务';
        
        this.initializeElements();
        this.initializeEventListeners();
    }

    initializeElements() {
        // 输入区域
        this.taskInputSection = document.getElementById('taskInputSection');
        this.feedbackSection = document.getElementById('feedbackSection');
        this.userTaskInput = document.getElementById('userTask');
        this.userFeedbackInput = document.getElementById('userFeedback');
        
        // 按钮
        this.startSessionBtn = document.getElementById('startSession');
        this.submitFeedbackBtn = document.getElementById('submitFeedback');
        this.exportResultsBtn = document.getElementById('exportResults');
        
        // 显示区域
        this.chatMessages = document.getElementById('chatMessages');
        this.recommendationBox = document.getElementById('recommendationBox');
        this.modelBadge = document.getElementById('modelBadge');
        
        // 状态显示
        this.currentStatusEl = document.getElementById('currentStatus');
        this.currentIterationEl = document.getElementById('currentIteration');
        this.currentModelEl = document.getElementById('currentModel');
        this.iterationCountEl = document.getElementById('iterationCount');
        
        // 加载动画
        this.loader = document.getElementById('loader');
        this.loaderText = document.getElementById('loaderText');
    }

    initializeEventListeners() {
        this.startSessionBtn.addEventListener('click', () => this.startSession());
        this.submitFeedbackBtn.addEventListener('click', () => this.submitFeedback());
        this.exportResultsBtn.addEventListener('click', () => this.exportResults());
        
        // 回车键发送
        this.userTaskInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.startSession();
            }
        });
        
        this.userFeedbackInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.submitFeedback();
            }
        });
    }

    async startSession() {
        const userTask = this.userTaskInput.value.trim();
        if (!userTask) {
            this.showMessage('请输入任务描述', 'warning');
            return;
        }

        this.showLoader('正在创建会话...');
        this.startSessionBtn.disabled = true;

        try {
            const response = await fetch('/api/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userTask })
            });

            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || '创建会话失败');
            }

            this.sessionId = data.sessionId;
            this.currentIteration = 1;
            this.updateStatus('正在分析需求...', this.currentIteration);
            
            // 显示用户消息
            this.addMessage(userTask, 'user', '您');
            
            // 切换到反馈模式
            this.taskInputSection.style.display = 'none';
            this.feedbackSection.style.display = 'block';
            
            // 开始获取推荐
            await this.getRecommendation();
            
        } catch (error) {
            this.showMessage(`错误: ${error.message}`, 'error');
        } finally {
            this.hideLoader();
            this.startSessionBtn.disabled = false;
        }
    }

    async getRecommendation() {
        if (!this.sessionId) return;

        this.showLoader('AI正在分析需求并生成推荐...');
        this.submitFeedbackBtn.disabled = true;

        try {
            const response = await fetch('/api/recommend/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: this.sessionId })
            });

            if (!response.ok) {
                throw new Error('获取推荐失败');
            }

            // 清空之前的AI消息
            this.removeLastAIMessage();
            
            // 创建新的AI消息容器
            const aiMessageDiv = this.addMessage('', 'ai', 'AIGuide', true);
            const messageContent = aiMessageDiv.querySelector('.message-content');

            // 处理流式响应
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        if (dataStr) {
                            try {
                                const data = JSON.parse(dataStr);
                                
                                if (data.type === 'chunk') {
                                    // 追加内容
                                    messageContent.textContent += data.content;
                                    // 滚动到底部
                                    this.scrollToBottom();
                                } else if (data.type === 'complete') {
                                    // 更新状态
                                    this.currentIteration = data.iterationCount;
                                    this.updateStatus('等待反馈', this.currentIteration);
                                    
                                    // 显示推荐结果
                                    if (data.recommendation) {
                                        this.displayRecommendation(data.recommendation);
                                    }
                                    
                                    this.hideLoader();
                                    this.submitFeedbackBtn.disabled = false;
                                    this.userFeedbackInput.focus();
                                } else if (data.type === 'error') {
                                    throw new Error(data.message);
                                }
                            } catch (error) {
                                console.error('解析流式数据失败:', error);
                            }
                        }
                    }
                }
            }

        } catch (error) {
            this.showMessage(`错误: ${error.message}`, 'error');
            this.hideLoader();
            this.submitFeedbackBtn.disabled = false;
        }
    }

    async submitFeedback() {
        const userFeedback = this.userFeedbackInput.value.trim();
        if (!userFeedback) {
            this.showMessage('请输入反馈', 'warning');
            return;
        }

        if (!this.sessionId) {
            this.showMessage('会话不存在', 'error');
            return;
        }

        // 显示用户反馈消息
        this.addMessage(userFeedback, 'user', '您');
        this.userFeedbackInput.value = '';

        this.showLoader('正在分析您的反馈...');
        this.submitFeedbackBtn.disabled = true;

        try {
            const response = await fetch('/api/analyze/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.sessionId,
                    userFeedback
                })
            });

            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || '分析反馈失败');
            }

            if (data.shouldContinue) {
                // 继续对话
                this.updateStatus('正在根据反馈优化...', data.iterationCount);
                await this.getRecommendation();
            } else {
                // 用户满意，结束对话
                this.updateStatus('用户满意，对话结束', this.currentIteration);
                this.showMessage('感谢您的认可！对话已结束。', 'success');
                this.submitFeedbackBtn.disabled = true;
                this.userFeedbackInput.disabled = true;
            }

        } catch (error) {
            this.showMessage(`错误: ${error.message}`, 'error');
            this.hideLoader();
            this.submitFeedbackBtn.disabled = false;
        }
    }

    async exportResults() {
        if (!this.sessionId) {
            this.showMessage('没有可导出的结果', 'warning');
            return;
        }

        this.showLoader('正在导出结果...');

        try {
            const response = await fetch(`/api/export/${this.sessionId}`);
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || '导出失败');
            }

            // 创建下载链接
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aiguide-recommendation-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            
            this.showMessage('结果导出成功！', 'success');
            
        } catch (error) {
            this.showMessage(`导出失败: ${error.message}`, 'error');
        } finally {
            this.hideLoader();
        }
    }

    addMessage(content, sender, senderName, isStreaming = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;
        
        const timestamp = new Date().toLocaleTimeString('zh-CN', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        messageDiv.innerHTML = `
            <div class="message-header">
                <i class="fas ${sender === 'user' ? 'fa-user' : 'fa-robot'}"></i>
                <strong>${senderName}</strong>
                <span class="timestamp">${timestamp}</span>
            </div>
            <div class="message-content">${isStreaming ? '' : content}</div>
        `;
        
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
        
        return messageDiv;
    }

    removeLastAIMessage() {
        const messages = this.chatMessages.querySelectorAll('.message.ai');
        if (messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            if (lastMessage.querySelector('.message-content').textContent === '') {
                lastMessage.remove();
            }
        }
    }

    displayRecommendation(recommendation) {
        this.currentModel = recommendation.model;
        
        // 更新模型徽章
        this.modelBadge.textContent = recommendation.model;
        this.modelBadge.style.background = 'rgba(76, 175, 80, 0.2)';
        this.modelBadge.style.color = '#2e7d32';
        
        // 更新状态
        this.currentModelEl.textContent = recommendation.model;
        
        // 显示推荐内容
        this.recommendationBox.innerHTML = `
            <div class="model-name">
                <i class="fas fa-microchip"></i> ${recommendation.model}
            </div>
            <div class="prompt-content">
                ${recommendation.prompt.replace(/\n/g, '<br>')}
            </div>
        `;
    }

    updateStatus(status, iteration) {
        this.currentStatus = status;
        this.currentIteration = iteration;
        
        this.currentStatusEl.textContent = status;
        this.currentIterationEl.textContent = iteration;
        this.iterationCountEl.textContent = iteration;
    }

    showLoader(text) {
        this.loaderText.textContent = text;
        this.loader.style.display = 'flex';
    }

    hideLoader() {
        this.loader.style.display = 'none';
    }

    scrollToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    showMessage(text, type = 'info') {
        // 在实际应用中，可以添加一个消息提示系统
        console.log(`[${type}] ${text}`);
        alert(text);
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new AIGuideApp();
});