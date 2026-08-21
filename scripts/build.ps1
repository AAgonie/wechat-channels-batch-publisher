param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\dist")
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$chromeManifestPath = Join-Path $projectRoot "manifest.json"
$edgeManifestPath = Join-Path $projectRoot "manifest.edge.json"
$chromeManifest = Get-Content -Raw -LiteralPath $chromeManifestPath | ConvertFrom-Json
$edgeManifest = Get-Content -Raw -LiteralPath $edgeManifestPath | ConvertFrom-Json

if ($chromeManifest.version -ne $edgeManifest.version) {
    throw "Chrome 与 Edge 版本号不一致。"
}

$version = $chromeManifest.version
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stageRoot = Join-Path $tempBase ("video-batch-assistant-" + [guid]::NewGuid().ToString("N"))
$chromeStage = Join-Path $stageRoot "chrome"
$edgeStage = Join-Path $stageRoot "edge"

try {
    New-Item -ItemType Directory -Path $outputRoot, $chromeStage, $edgeStage -Force | Out-Null

    foreach ($stage in @($chromeStage, $edgeStage)) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "background.js") -Destination $stage
        Copy-Item -LiteralPath (Join-Path $projectRoot "content.js") -Destination $stage
        Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $stage
    }

    Copy-Item -LiteralPath $chromeManifestPath -Destination (Join-Path $chromeStage "manifest.json")
    Copy-Item -LiteralPath $edgeManifestPath -Destination (Join-Path $edgeStage "manifest.json")

    $chromeZip = Join-Path $outputRoot "video-batch-assistant-chrome-v$version.zip"
    $edgeZip = Join-Path $outputRoot "video-batch-assistant-edge-v$version.zip"

    Compress-Archive -Path (Join-Path $chromeStage "*") -DestinationPath $chromeZip -Force
    Compress-Archive -Path (Join-Path $edgeStage "*") -DestinationPath $edgeZip -Force

    Get-FileHash -Algorithm SHA256 -LiteralPath $chromeZip, $edgeZip |
        Select-Object Path, Hash
}
finally {
    $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
    if ($resolvedStage.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
