#!/bin/sh
# Рабочая ли видеокарта для локального ИИ (HQ-016). Печатает одну строку JSON:
#   {"state": "ready|no_driver|no_image|none", "backend": "cuda|vulkan"|null, "device": "Vulkan1"|null,
#    "name": "...", "vram_mb": 4096}
# Рабочая = её видит сам llama.cpp в контейнере (--list-devices), а не «есть драйвер»:
# так проверка одинакова для проприетарного драйвера NVIDIA (CUDA), открытых драйверов
# Mesa — NVK, RADV — и Docker Desktop. Встроенную графику Intel не берём: она не быстрее
# процессора. Образы — LLM_GPU_IMAGE (CUDA) и LLM_VULKAN_IMAGE; нет образа — нет и проверки.
set -u
CUDA_IMAGE=${LLM_GPU_IMAGE:-arm112-llm-cuda:0.1.0}
VULKAN_IMAGE=${LLM_VULKAN_IMAGE:-arm112-llm-vulkan:0.1.0}

quote() { # строка JSON или null
  if [ -n "$1" ]; then printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; else printf null; fi
}
json() { # $1 state, $2 backend, $3 device, $4 name, $5 vram_mb
  printf '{"state": "%s", "backend": %s, "device": %s, "name": %s, "vram_mb": %s}\n' \
    "$1" "$(quote "$2")" "$(quote "$3")" "$(quote "$4")" "${5:-null}"
}

# Лучшее устройство из вывода --list-devices: «  Vulkan1: NAME (4096 MiB, 3686 MiB free)».
# Дискретные NVIDIA/AMD и Intel Arc — да; программный llvmpipe и встроенная Intel — нет.
best_device() {
  sed -n 's/^ *\([A-Za-z]*[0-9]*\): \(.*\) (\([0-9]*\) MiB.*$/\1|\2|\3/p' |
    grep -viE 'llvmpipe|lavapipe|swiftshader' |
    awk -F'|' '{ rank = ($2 ~ /NVIDIA|GeForce|RTX|Radeon|AMD|Arc/) ? 1 : 0; if (rank) print $3 "|" $0 }' |
    sort -t'|' -k1,1nr | head -n 1 | cut -d'|' -f2-
}

has_image() { docker image inspect "$1" >/dev/null 2>&1; }

# 1. CUDA: проприетарный драйвер NVIDIA и доступ контейнеров (toolkit или Docker Desktop).
if has_image "$CUDA_IMAGE" && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  found=$(docker run --rm --gpus all "$CUDA_IMAGE" --list-devices 2>/dev/null | best_device)
  if [ -n "$found" ]; then
    json ready cuda "$(echo "$found" | cut -d'|' -f1)" "$(echo "$found" | cut -d'|' -f2)" "$(echo "$found" | cut -d'|' -f3)"
    exit 0
  fi
fi

# 2. Vulkan: любая карта с драйвером Vulkan через /dev/dri (Linux).
if has_image "$VULKAN_IMAGE" && [ -d /dev/dri ]; then
  found=$(docker run --rm --device /dev/dri "$VULKAN_IMAGE" --list-devices 2>/dev/null | best_device)
  if [ -n "$found" ]; then
    json ready vulkan "$(echo "$found" | cut -d'|' -f1)" "$(echo "$found" | cut -d'|' -f2)" "$(echo "$found" | cut -d'|' -f3)"
    exit 0
  fi
fi

# 3. Контейнер карту не увидел: есть ли она вообще (PCI: NVIDIA 0x10de, AMD 0x1002).
for vendor in /sys/bus/pci/devices/*/vendor; do
  [ -r "$vendor" ] || continue
  case "$(cat "$vendor")" in 0x10de | 0x1002) ;; *) continue ;; esac
  dir=$(dirname "$vendor")
  case "$(cat "$dir/class" 2>/dev/null)" in 0x03*) ;; *) continue ;; esac
  name=""
  if command -v lspci >/dev/null 2>&1; then
    name=$(lspci -s "$(basename "$dir")" 2>/dev/null |
      sed 's/^[^:]*: *//; s/^[^:]*: *//; s/ (rev [^)]*)//; s/.*\[\(.*\)\].*/\1/')
  fi
  # Без образов llama.cpp для видеокарты проверить её нечем — это не «нет драйвера».
  if has_image "$CUDA_IMAGE" || has_image "$VULKAN_IMAGE"; then state=no_driver; else state=no_image; fi
  json "$state" "" "" "${name:-видеокарта}" ""
  exit 0
done
json none "" "" "" ""
