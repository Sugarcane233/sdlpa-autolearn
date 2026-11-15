# 安装开机自启：用户级计划任务，经 wscript 隐藏窗口拉起 daemon，无需管理员
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\jiaka\Documents\deepseek-harness\default-workspace\sdlpa'
$vbs  = Join-Path $root 'daemon-hidden.vbs'
$taskName = 'SDLPAAutoLearn'

$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 2) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -Priority 4 `
  -Hidden

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggerLogon -Settings $settings -Principal $principal | Out-Null
Write-Output "installed: $taskName"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-List
