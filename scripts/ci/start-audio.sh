#!/usr/bin/env bash
# Firefox в Linux воспроизводит звук через PulseAudio. В runner нет физического
# выхода: создаём виртуальный sink, сохраняя настоящее декодирование и событие ended.
set -euo pipefail

sudo apt-get install --yes --no-install-recommends pulseaudio pulseaudio-utils
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=arm112_ci rate=48000
pactl set-default-sink arm112_ci
pactl info
pactl list short sinks
