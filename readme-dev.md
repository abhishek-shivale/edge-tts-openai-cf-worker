# Edge TTS Worker 开发指南

本文档用于指导开发者如何在本地设置开发环境、运行测试和部署 Edge TTS Worker。

## 开发环境设置

### 前置要求
1. Node.js 18 或更高版本
2. npm 或 yarn
3. Git

### 安装开发工具
1. 安装 Wrangler CLI：
```bash
npm install -g wrangler
```

2. 登录到 Cloudflare：
```bash
wrangler login
```

## 本地开发

### 1. 克隆项目
```bash
git clone <项目地址>
cd edge-tts-worker
```

### 2. 配置开发环境
1. 创建 `wrangler.toml` 配置文件：
```toml
name = "edge-tts-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[dev]
ip = "0.0.0.0"
port = 8787
```

2. 创建本地环境变量文件 `.dev.vars`：
```plaintext
API_KEY=your-test-key
```

### 3. 运行开发服务器
```bash
wrangler dev
```
服务器将在 http://localhost:8787 启动

### 本地测试

#### 1. 使用 curl 测试 API

测试中文语音：
```bash
curl -X POST http://localhost:8787/v1/audio/speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-test-key" \
  -d '{
    "model": "tts-1",
    "input": "测试文本",
    "voice": "zh-CN-XiaoxiaoNeural"
  }' --output test.mp3
```

#### 2. 使用测试脚本
在本地开发环境中运行测试脚本：
```bash
./test_voices.sh http://localhost:8787 your-test-key
```

### 调试技巧

1. 查看日志：
```bash
# 实时查看日志
wrangler tail

# 开发模式下日志会直接显示在终端
```

2. 使用 console.log：
```javascript
// worker.js 中添加日志
console.log('请求参数:', request);
```

3. 测试不同配置：
- 修改 speed 和 pitch 参数
- 测试不同的语音模型
- 验证错误处理

## 部署流程

### 1. 运行单元测试
```bash
node --test worker.test.js
```

### 2. 测试构建
```bash
wrangler deploy --dry-run
```

### 3. 配置生产 API Key
```bash
wrangler secret put API_KEY
```

### 4. 部署到生产环境
```bash
wrangler deploy
```

## 常见开发问题

### 1. CORS 问题
如果遇到跨域问题，检查 worker.js 中的 CORS 配置：
```javascript
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
```

### 2. 环境变量问题
- 确保 `.dev.vars` 文件存在且格式正确
- 检查 `wrangler.toml` 中的变量配置

### 3. 请求超时
- 每个上游 WebSocket 请求有 30 秒超时
- 长文本会安全分块并按顺序合成
- 单次 API 输入上限为 100000 个字符


## 贡献指南

1. 提交 PR 前：
- 确保代码已经过本地测试
- 遵循项目的代码风格
- 更新相关文档

2. 代码审查
- 所有改动需要通过代码审查
- 遵循项目的贡献指南

## 有用的开发资源

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Wrangler CLI 文档](https://developers.cloudflare.com/workers/wrangler/)
- [Edge TTS API 文档](https://learn.microsoft.com/zh-cn/azure/cognitive-services/speech-service/rest-text-to-speech)
