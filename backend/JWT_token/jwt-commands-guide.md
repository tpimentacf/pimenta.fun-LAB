# Create a JWT Token — Copy-Paste Command Guide

## Notes

> Run every command exactly as shown. No editing required.

## 1. Install Prerequisites

```bash

## Debian / Ubuntu

sudo apt-get update && sudo apt-get install -y python3 python3-pip openssl

## macOS

brew install python3 openssl

## Install Python libraries

If you wish to install a Python library that isn\'t in Homebrew, use a virtual environment:

    python3 -m venv venv
    source venv/bin/activate
    python3 -m pip install PyJWT cryptography

## Run the script end-to-end, create_jwt.py (define the parameters in the file)
    python3 create_jwt.py generate   # Creates private.pem, public.pem, keypair.jwk
    python3 create_jwt.py sign       # Creates token.txt with signed JWT
    python3 create_jwt.py verify     # Validates signature + claims
    python3 create_jwt.py inspect      # Decodes without verifying


## # Deactivate (for the current shell session)
    deactivate
```
