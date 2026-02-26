$env:SKIP_NATIVE_BUILD = "true"
$env:Path = $env:Path + ";" + $env:USERPROFILE + "\.cargo\bin"
npm run dev