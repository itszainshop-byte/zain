## Cloud Run container for Node.js API when build CONTEXT is the REPO ROOT (Dockerfile in project/)
## This version explicitly copies the project/ subfolder so CMD can find server/index.js at /app/project/server/index.js.

FROM node:20-alpine

# Build CONTEXT expected: project/ subfolder (this Dockerfile lives here)
WORKDIR /app

# Copy manifests for layer caching (project-context)
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev || npm ci --only=production

# Copy application source (project-context)
COPY . ./

# Environment
ARG MONGODB_URI="mongodb+srv://omranmahmoud888:pass12345@cluster0.n5s9xa1.mongodb.net/zain?retryWrites=true&w=majority&appName=Cluster0"
ENV NODE_ENV=production
ENV MONGODB_URI=${MONGODB_URI}
ENV PORT=8080

EXPOSE 8080

# Start API
CMD ["node", "server/index.js"]
