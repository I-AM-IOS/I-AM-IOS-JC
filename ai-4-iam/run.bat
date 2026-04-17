@echo off
REM I-AM-AI Quick Setup & Run (Windows)

echo.
echo ╔════════════════════════════════════════════════════╗
echo ║       I-AM-AI: Ollama3.2 + Sub-Conscience         ║
echo ╚════════════════════════════════════════════════════╝
echo.

REM Check if Ollama is running
echo 🔍 Checking Ollama...
powershell -Command "(New-Object Net.WebClient).DownloadString('http://localhost:11434/api/tags') | Out-Null" 2>nul
if %errorlevel% equ 0 (
    echo ✓ Ollama is running
) else (
    echo ✗ Ollama not running. Start it with: ollama serve
    echo.
)

echo.
echo 📁 Files location: %CD%
echo.
echo Files needed:
echo   ✓ I-AM-AI-OLLAMA3.html
echo   ✓ sw-subconscience.js
echo   ✓ README.md
echo.

REM Check for Python
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo 🚀 Starting local server with Python...
    echo.
    echo 📡 Open your browser to: http://localhost:8000
    echo 📝 File: http://localhost:8000/I-AM-AI-OLLAMA3.html
    echo.
    echo Press Ctrl+C to stop
    echo.
    python -m http.server 8000
    goto done
)

REM Check for Node.js
npx --version >nul 2>&1
if %errorlevel% equ 0 (
    echo 🚀 Starting local server with Node.js...
    echo.
    echo 📡 Open your browser to: http://localhost:8000
    echo 📝 File: http://localhost:8000/I-AM-AI-OLLAMA3.html
    echo.
    echo Press Ctrl+C to stop
    echo.
    npx http-server -p 8000
    goto done
)

REM If no server found
echo ✗ No suitable server found. Install Python or Node.js
echo.
echo Option 1: Install Python https://python.org
echo Option 2: Install Node.js https://nodejs.org
echo Option 3: Use any local web server pointing to %CD%
echo.

:done
pause
