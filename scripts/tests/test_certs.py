import importlib.util
import ssl
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import padding


def certificate_module():
    path = Path(__file__).resolve().parents[2] / "deploy/certs/make_ca.py"
    spec = importlib.util.spec_from_file_location("make_ca", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_local_ca_signs_server_and_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("CERT_HOSTNAMES", "localhost,127.0.0.1,192.0.2.10")
    module = certificate_module()
    module.create(tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    module.create(tmp_path)
    assert before == {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    ca = x509.load_pem_x509_certificate(before["ca.crt"])
    server = x509.load_pem_x509_certificate(before["server.crt"])
    assert server.issuer == ca.subject
    ca.public_key().verify(
        server.signature,
        server.tbs_certificate_bytes,
        padding.PKCS1v15(),
        server.signature_hash_algorithm,
    )
    assert "localhost" in server.extensions.get_extension_for_class(
        x509.SubjectAlternativeName
    ).value.get_values_for_type(x509.DNSName)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(tmp_path / "server.crt", tmp_path / "server.key")


def test_partial_certificates_are_not_overwritten(tmp_path):
    original = b"existing-private-key"
    (tmp_path / "ca.key").write_bytes(original)
    with pytest.raises(ValueError, match="ключи"):
        certificate_module().create(tmp_path)
    assert (tmp_path / "ca.key").read_bytes() == original
