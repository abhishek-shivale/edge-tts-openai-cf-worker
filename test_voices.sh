#!/bin/bash

# 检查命令行参数
if [ $# -lt 1 ]; then
    echo "使用方法: $0 <WORKER_URL> [API_KEY]"
    echo "示例: $0 https://example.com api_key_123"
    exit 1
fi

# 从命令行参数获取配置
WORKER_URL="$1"
API_KEY="${2:-}"  # 如果没有提供第二个参数，API_KEY 将为空

# 验证 WORKER_URL
if [[ ! "$WORKER_URL" =~ ^https?:// ]]; then
    echo "错误: WORKER_URL 必须以 http:// 或 https:// 开头"
    exit 1
fi

# 确保 URL 末尾没有斜杠，然后添加 API 路径
WORKER_URL="${WORKER_URL%/}/v1/audio/speech"

# 创建输出目录（使用绝对路径）
OUTPUT_DIR="$(pwd)/test/voice_test_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTPUT_DIR"

# 要测试的语音列表
VOICES=(
    "alloy"
    "echo"
    "fable"
    "onyx"
    "nova"
    "shimmer"
    "zh-CN-XiaoxiaoNeural"
    "zh-CN-XiaoyiNeural" 
    "zh-CN-YunxiNeural"
    "zh-CN-YunyangNeural"
    "zh-CN-XiaohanNeural"
    "zh-CN-XiaomengNeural"
    "zh-CN-XiaochenNeural"
    "zh-CN-XiaoruiNeural"
    "zh-CN-XiaoshuangNeural"
    "zh-CN-YunfengNeural"
    "zh-CN-YunjianNeural"
    "zh-CN-XiaoxuanNeural"
    "zh-CN-YunxiaNeural"
    "zh-CN-XiaomoNeural"
    "zh-CN-XiaozhenNeural"
    "en-US-JennyNeural"
    "en-US-GuyNeural"
    "ja-JP-NanamiNeural"
    "ja-JP-KeitaNeural"
    "ko-KR-SunHiNeural"
    "ko-KR-InJoonNeural"
)

# 测试文本
TEXTS=(
    "你好世界"
    "Hello World"
    "こんにちは世界"
    "안녕하세요 세계"
)

# 检查MP3文件是否有效
check_mp3() {
    local file="$1"
    # 检查文件大小是否大于0
    if [ ! -s "$file" ]; then
        echo "文件大小为0" >&2
        return 1
    fi
    # 使用 file 命令检查文件类型
    if ! file "$file" | grep -qi "audio\|mpeg\|mp3"; then
        echo "不是有效的音频文件" >&2
        echo "文件类型:" >&2
        file "$file" >&2
        return 1
    fi
    return 0
}

echo "开始测试语音..."
echo "输出目录: $OUTPUT_DIR"
echo "----------------------------------------"

# 构建curl命令的headers
HEADERS=(-H "Content-Type: application/json")
if [ ! -z "$API_KEY" ]; then
    HEADERS+=(-H "Authorization: Bearer $API_KEY")
fi

# 创建测试结果日志
RESULT_LOG="$OUTPUT_DIR/test_results.txt"
echo "语音测试结果 - $(date '+%Y年 %m月 %d日 %A %H:%M:%S %Z')" > "$RESULT_LOG"
echo "----------------------------------------" >> "$RESULT_LOG"

# 成功计数器
success_count=0
total_count=${#VOICES[@]}

for voice in "${VOICES[@]}"; do
    echo "测试语音: $voice"
    echo "测试语音: $voice" >> "$RESULT_LOG"
    
    # 根据语音选择合适的测试文本
    text="${TEXTS[0]}"  # 默认使用中文
    if [[ $voice == en-US-* ]]; then
        text="${TEXTS[1]}"  # 英文
    elif [[ $voice == ja-JP-* ]]; then
        text="${TEXTS[2]}"  # 日文
    elif [[ $voice == ko-KR-* ]]; then
        text="${TEXTS[3]}"  # 韩文
    fi
    
    output_file="$OUTPUT_DIR/test_${voice}.mp3"
    
    # 发送请求并保存响应
    response=$(curl -s -w "\n%{http_code}" -X POST "$WORKER_URL" \
        "${HEADERS[@]}" \
        -d "{
            \"model\": \"tts-1\",
            \"input\": \"$text\",
            \"voice\": \"$voice\",
            \"response_format\": \"mp3\",
            \"speed\": 1.0
        }" -o "$output_file")
    
    # 获取 HTTP 状态码
    http_code=$(echo "$response" | tail -n1)
    
    # 检查结果
    if [ "$http_code" == "200" ]; then
        if check_mp3 "$output_file"; then
            echo "✅ 成功 - 已保存到 $output_file"
            echo "✅ 成功" >> "$RESULT_LOG"
            ((success_count++))
        else
            error_msg=$(check_mp3 "$output_file" 2>&1)
            echo "❌ 失败 - 文件验证失败: $error_msg"
            echo "❌ 失败 - 文件验证失败: $error_msg" >> "$RESULT_LOG"
            # 创建 errors 子目录
            mkdir -p "$OUTPUT_DIR/errors"
            # 移动到 errors 目录，保持原始文件名
            mv "$output_file" "$OUTPUT_DIR/errors/$(basename "$output_file")"
            echo "已保存错误响应到: $OUTPUT_DIR/errors/$(basename "$output_file")"
        fi
    else
        echo "❌ 失败 (HTTP $http_code)"
        echo "❌ 失败 (HTTP $http_code)" >> "$RESULT_LOG"
        mkdir -p "$OUTPUT_DIR/errors"
        error_file="$OUTPUT_DIR/errors/$(basename "$output_file" .mp3).json"
        if [ -f "$output_file" ]; then
            mv "$output_file" "$error_file"
            error_message=$(tr '\n' ' ' < "$error_file")
        else
            error_message="请求失败，未收到响应体"
        fi
        echo "错误响应: $error_message"
        echo "错误响应: $error_message" >> "$RESULT_LOG"
    fi
    echo "----------------------------------------" | tee -a "$RESULT_LOG"
done

# 输出测试总结
echo -e "\n测试完成！"
echo -e "\n测试总结：" >> "$RESULT_LOG"
echo "总计测试: $total_count" | tee -a "$RESULT_LOG"
echo "成功数量: $success_count" | tee -a "$RESULT_LOG"
echo "失败数量: $((total_count - success_count))" | tee -a "$RESULT_LOG"
echo "成功率: $((success_count * 100 / total_count))%" | tee -a "$RESULT_LOG"

# 列出成功生成的文件
echo -e "\n成功生成的语音文件："
ls -lh "$OUTPUT_DIR"/*.mp3 2>/dev/null

# 如果全部失败，给出提示
if [ $success_count -eq 0 ]; then
    echo -e "\n⚠️  警告：所有测试都失败了！"
    echo "请检查："
    echo "1. Worker URL 是否正确"
    echo "2. API Key 是否正确（如果需要）"
    echo "3. 网络连接是否正常"
fi
