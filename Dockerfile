# 使用 Node.js 20 LTS 作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 安装依赖（利用 Docker 缓存层）
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# 复制项目文件
COPY . .

# 创建数据目录
RUN mkdir -p /app/data /app/logs

# 创建非 root 用户
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 9768

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:9768/ || exit 1

# 启动命令（使用 PM2）
CMD ["node", "node_modules/pm2/bin/pm2", "start", "ecosystem.config.js", "--no-daemon"]
