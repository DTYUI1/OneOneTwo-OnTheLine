"""Локальный CA создаётся в volume; системное доверие автоматически не меняется."""

import argparse
import ipaddress
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def create(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    if (output / "server.crt").exists():
        if not all((output / file).exists() for file in ["server.key", "ca.crt", "ca.key"]):
            raise ValueError("Неполный набор сертификатов; требуется ручная проверка volume")
        return
    if any((output / name).exists() for name in ["ca.crt", "ca.key", "server.key"]):
        raise ValueError("Обнаружены существующие ключи; автоматическая перезапись запрещена")
    now = datetime.now(UTC)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ARM112 Development CA")])
    ca = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    names: list[x509.GeneralName] = []
    for hostname in os.getenv("CERT_HOSTNAMES", "localhost,127.0.0.1").split(","):
        hostname = hostname.strip()
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(hostname)))
        except ValueError:
            names.append(x509.DNSName(hostname))
    certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ARM112 local")]))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    for filename, private in [("ca.key", ca_key), ("server.key", key)]:
        (output / filename).write_bytes(
            private.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        (output / filename).chmod(0o600)
    (output / "ca.crt").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (output / "server.crt").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    create(parser.parse_args().output)
