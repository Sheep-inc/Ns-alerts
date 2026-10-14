#!/bin/sh
# Start/herstart NS treinalerts op de achtergrond (poort 8780)
cd "$(dirname "$0")"; mkdir -p data
pkill -f "python3 .*ns-alerts/app.py" 2>/dev/null; sleep 1
nohup python3 "$PWD/app.py" >> data/app.log 2>&1 &
echo "gestart (pid $!), UI: http://localhost:8780, log: data/app.log"
