param([Parameter(Mandatory=$true)][string]$CertificatePath)
$ErrorActionPreference = 'Stop'
Import-Certificate -FilePath (Resolve-Path -LiteralPath $CertificatePath).Path -CertStoreLocation Cert:\CurrentUser\Root
