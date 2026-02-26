$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -property installationPath -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86_x64
Write-Host "VS Path: $vsPath"

$vcvars = "$vsPath\VC\Auxiliary\Build\vcvars64.bat"
Write-Host "VCVars: $vcvars"

$tempFile = [System.IO.Path]::GetTempFileName()
$envFile = [System.IO.Path]::GetTempFileName()

$cmd = "`"$vcvars`" && set > `"$envFile`""
cmd /c $cmd

Get-Content $envFile | ForEach-Object {
    if ($_ -match '^(.+?)=(.*)$') {
        $name = $matches[1]
        $value = $matches[2]
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
        Set-Item -Path "env:$name" -Value $value
    }
}

Remove-Item $envFile -Force

$env:Path = $env:Path + ";" + $env:USERPROFILE + "\.cargo\bin"
Write-Host "PATH updated"

npm run dev