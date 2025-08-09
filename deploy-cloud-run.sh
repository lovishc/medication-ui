#!/bin/bash

# Medicine Search App - Google Cloud Run Deployment
# Project: clinware-snf-dev-lovish

echo "🏥 Medicine Search App - Google Cloud Run Deployment"
echo "=================================================="

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ Error: gcloud CLI is not installed. Please install it first."
    echo "Visit: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if user is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "❌ Error: Not authenticated with gcloud. Please run: gcloud auth login"
    exit 1
fi

# Set the project
echo "📋 Setting project to: clinware-snf-dev-lovish"
gcloud config set project clinware-snf-dev-lovish

# Check if project exists and user has access
if ! gcloud projects describe clinware-snf-dev-lovish &> /dev/null; then
    echo "❌ Error: Project 'clinware-snf-dev-lovish' not found or access denied."
    echo "Please check your project ID and permissions."
    exit 1
fi

echo "✅ Project verified successfully!"

# Enable required APIs
echo "🔧 Enabling required APIs..."
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build the React app
echo "🔨 Building React app..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed! Please check for errors."
    exit 1
fi

echo "✅ Build completed successfully!"

# Create a simple Dockerfile for serving static files
echo "🐳 Creating Dockerfile..."
cat > Dockerfile << 'EOF'
FROM nginx:alpine
COPY build/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
EOF

# Create nginx configuration
echo "⚙️ Creating nginx configuration..."
cat > nginx.conf << 'EOF'
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    
    server {
        listen 8080;
        server_name localhost;
        root /usr/share/nginx/html;
        index index.html;
        
        location / {
            try_files $uri $uri/ /index.html;
        }
        
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
}
EOF

# Build and deploy to Cloud Run
echo "🚀 Building and deploying to Cloud Run..."
SERVICE_NAME="medicine-search-app"
REGION="us-central1"

# Build the container
gcloud builds submit --tag gcr.io/clinware-snf-dev-lovish/$SERVICE_NAME

if [ $? -ne 0 ]; then
    echo "❌ Container build failed!"
    exit 1
fi

# Deploy to Cloud Run
gcloud run deploy $SERVICE_NAME \
  --image gcr.io/clinware-snf-dev-lovish/$SERVICE_NAME \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --max-instances 10 \
  --timeout 300 \
  --concurrency 80

if [ $? -eq 0 ]; then
    echo "✅ Deployment successful!"
    echo "🌐 Your app is now live at:"
    gcloud run services describe $SERVICE_NAME --region=$REGION --format="value(status.url)"
    echo ""
    echo "📊 To view logs:"
    echo "   gcloud logs tail --service=$SERVICE_NAME --region=$REGION"
    echo ""
    echo "🔧 To manage your service:"
    echo "   https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME"
else
    echo "❌ Deployment failed! Please check the error messages above."
    exit 1
fi

# Clean up temporary files
rm -f Dockerfile nginx.conf
