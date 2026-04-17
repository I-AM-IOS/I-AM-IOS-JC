#!/bin/bash
# I-AM-AI Quick Setup & Run

echo "╔════════════════════════════════════════════════════╗"
echo "║       I-AM-AI: Ollama3.2 + Sub-Conscience         ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

# Check if Ollama is running
echo "🔍 Checking Ollama..."
if curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "✓ Ollama is running"
else
    echo "✗ Ollama not running. Start it with: ollama serve"
    echo ""
fi

# Get the directory where this script is
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo ""
echo "📁 Files location: $DIR"
echo ""
echo "Files needed:"
echo "  ✓ I-AM-AI-OLLAMA3.html"
echo "  ✓ sw-subconscience.js"
echo "  ✓ README.md"
echo ""

# Check if http.server is available (Python 3)
if command -v python3 &> /dev/null; then
    echo "🚀 Starting local server..."
    echo ""
    echo "📡 Open your browser to: http://localhost:8000"
    echo "📝 Files: http://localhost:8000/I-AM-AI-OLLAMA3.html"
    echo ""
    echo "Press Ctrl+C to stop"
    echo ""
    cd "$DIR"
    python3 -m http.server 8000
elif command -v python &> /dev/null; then
    echo "🚀 Starting local server (Python 2)..."
    echo ""
    echo "📡 Open your browser to: http://localhost:8000"
    echo "📝 Files: http://localhost:8000/I-AM-AI-OLLAMA3.html"
    echo ""
    echo "Press Ctrl+C to stop"
    echo ""
    cd "$DIR"
    python -m SimpleHTTPServer 8000
elif command -v npx &> /dev/null; then
    echo "🚀 Starting local server with Node.js..."
    echo ""
    echo "📡 Open your browser to: http://localhost:8000"
    echo "📝 Files: http://localhost:8000/I-AM-AI-OLLAMA3.html"
    echo ""
    echo "Press Ctrl+C to stop"
    echo ""
    cd "$DIR"
    npx http-server -p 8000
else
    echo "✗ No suitable server found. Install Python 3 or Node.js"
    echo ""
    echo "Or manually start a server:"
    echo "  cd $DIR"
    echo "  python3 -m http.server 8000"
    exit 1
fi
