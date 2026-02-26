$vsPath = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
if ($vsPath) {
    $vcvarsPath = "$vsPath\VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path $vcvarsPath) {
        cmd /c "`"$vcvarsPath`" && set" | ForEach-Object {
            if ($_ -match '^(.+?)=(.*)$') {
                [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
            }
        }
    }
}
$env:Path = $env:Path + ";" + $env:USERPROFILE + "\.cargo\bin"
npm run dev