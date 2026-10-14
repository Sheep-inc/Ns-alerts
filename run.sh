#!/bin/sh
# Start/herstart NS treinalerts op de achtergrond (poort 8780)
cd "$(dirname "$0")"
mkdir -p data
pkill -f "$PWD/app.js" 2>/dev/null
sleep 1
nohup node "$PWD/app.js" >> data/app.log 2>&1 &
echo "gestart (pid $!), UI: http://localhost:8780, log: data/app.log"
