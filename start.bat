@echo off
rem Arrival 风格 3D 查看器 - 一键启动
cd /d "%~dp0"
start "" http://localhost:8080
node server.js 8080
