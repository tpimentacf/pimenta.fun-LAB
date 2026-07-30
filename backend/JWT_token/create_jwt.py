#!/usr/bin/env python3
"""Create and verify a JWT token using PyJWT."""
import sys, os, json, time, base64
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

def b64url(n, length=32):
    return base64.urlsafe_b64encode(n.to_bytes(length, "big")).rstrip(b"=").decode()

def generate():
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    )
    open("private.pem","wb").write(private_pem)
    open("public.pem","wb").write(public_pem)

    pub_nums = public_key.public_numbers()
    priv_nums = private_key.private_numbers()
    jwk = {
        "kty":"EC","crv":"P-256","kid":"tpimentacf",
        "x":b64url(pub_nums.x),"y":b64url(pub_nums.y),
        "d":b64url(priv_nums.private_value),"alg":"ES256","use":"sig"
    }
    open("keypair.jwk","w").write(json.dumps(jwk, indent=2))
    print("Keys written: private.pem, public.pem, keypair.jwk")

def sign():
    now = int(time.time())
    payload = {
        "sub":"pimentacf","iss":"pimenta-api","aud":"cloudflare",
        "iat":now,"exp":now+3600,"custom_claim":"value"
    }
    token = jwt.encode(payload, open("private.pem","rb").read(), algorithm="ES256", headers={"kid":"tpimentacf"})
    open("token.txt","w").write(token)
    print("JWT token written to token.txt")
    return token

def verify():
    token = open("token.txt").read().strip()
    decoded = jwt.decode(token, open("public.pem","rb").read(), algorithms=["ES256"], audience="cloudflare", issuer="pimenta-api")
    print("Verified payload:", json.dumps(decoded, indent=2))

def inspect():
    token = open("token.txt").read().strip()
    h,p,_ = token.split(".")
    header = json.loads(base64.urlsafe_b64decode(h+"=="))
    payload = json.loads(base64.urlsafe_b64decode(p+"=="))
    print("Header:", json.dumps(header, indent=2))
    print("Payload:", json.dumps(payload, indent=2))

if __name__ == "__main__":
    if "generate" in sys.argv: generate()
    elif "sign" in sys.argv: print(sign())
    elif "verify" in sys.argv: verify()
    elif "inspect" in sys.argv: inspect()
    else: print("Usage: python3 create_jwt.py [generate|sign|verify|inspect]")

