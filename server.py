#!/usr/bin/env python3
"""Ponto de entrada na raiz do projeto para o servidor do simulador ESP32."""

import sys
from pathlib import Path

SIMULADOR_DIR = Path(__file__).resolve().parent / "simulador"
sys.path.insert(0, str(SIMULADOR_DIR))

import server

if __name__ == "__main__":
    server.main()

