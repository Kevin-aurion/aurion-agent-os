Option Explicit

Dim shell, fileSystem, baseDirectory, scriptPath, logPath, quote, command, result
Dim recoveryRoot, recoveryScript, recoveryCommand, packageUrl
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

baseDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fileSystem.BuildPath(baseDirectory, "resources\Update-Aurion-AIOS-Plugins.ps1")
logPath = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "Aurion AIOS Updater.log")
quote = Chr(34)

If Not fileSystem.FileExists(scriptPath) Then
  ' Windows Explorer may run only this VBS when a user double-clicks it inside
  ' the ZIP preview. In that case the sibling resources folder is not extracted.
  ' Recover the complete package automatically instead of reporting corruption.
  packageUrl = "https://aurion-aios.lazyoffice.app/downloads/agent-builder/aurion-aios-plugin-updater-windows-v4.zip"
  recoveryRoot = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "Aurion AIOS\Updater Recovery v4")
  recoveryScript = fileSystem.BuildPath(recoveryRoot, "package\aurion-aios-plugin-updater-windows\resources\Update-Aurion-AIOS-Plugins.ps1")

  shell.Popup "The ZIP was not fully extracted. Aurion AIOS will download the complete package automatically.", 8, "Aurion AIOS Updater", 64

  recoveryCommand = "$ErrorActionPreference='Stop'; " & _
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " & _
    "$root=Join-Path $env:LOCALAPPDATA 'Aurion AIOS\Updater Recovery v4'; " & _
    "$archive=Join-Path $root 'updater.zip'; $package=Join-Path $root 'package'; " & _
    "if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}; " & _
    "New-Item -ItemType Directory -Path $root -Force | Out-Null; " & _
    "Invoke-WebRequest -UseBasicParsing -Uri '" & packageUrl & "' -OutFile $archive; " & _
    "Expand-Archive -LiteralPath $archive -DestinationPath $package -Force; " & _
    "$script=Join-Path $package 'aurion-aios-plugin-updater-windows\resources\Update-Aurion-AIOS-Plugins.ps1'; " & _
    "$claudeManifest=Join-Path $package 'aurion-aios-plugin-updater-windows\resources\marketplace\.claude-plugin\marketplace.json'; " & _
    "$codexManifest=Join-Path $package 'aurion-aios-plugin-updater-windows\resources\marketplace\.agents\plugins\marketplace.json'; " & _
    "if(-not(Test-Path -LiteralPath $script -PathType Leaf) -or -not(Test-Path -LiteralPath $claudeManifest -PathType Leaf) -or -not(Test-Path -LiteralPath $codexManifest -PathType Leaf)){throw 'Downloaded package is incomplete'}"

  command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command " & quote & recoveryCommand & quote
  result = shell.Run(command, 0, True)
  If result <> 0 Or Not fileSystem.FileExists(recoveryScript) Then
    MsgBox "The complete package could not be downloaded. Please right-click the ZIP, choose Extract All, then double-click this file again.", 16, "Aurion AIOS Updater"
    WScript.Quit 1
  End If
  scriptPath = recoveryScript
End If

shell.Popup "Aurion AIOS will be installed or updated in the background. If authorization is needed, your browser will open automatically.", 5, "Aurion AIOS Updater", 64

command = "cmd.exe /d /c " & quote & _
  "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File " & quote & scriptPath & quote & _
  " > " & quote & logPath & quote & " 2>&1" & quote
result = shell.Run(command, 0, True)

If result = 0 Then
  MsgBox "Installation or update completed. Restart Claude or Codex and open a new conversation.", 64, "Aurion AIOS Updater"
Else
  MsgBox "Some items were not completed. The update log will open now.", 48, "Aurion AIOS Updater"
  If fileSystem.FileExists(logPath) Then
    shell.Run "notepad.exe " & quote & logPath & quote, 1, False
  End If
End If

WScript.Quit result
