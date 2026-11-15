# 人工介入提醒：data/NEED_MANUAL 出现时弹一个 Windows 通知（只在需要人时弹）
$root = 'C:\Users\jiaka\Documents\deepseek-harness\default-workspace\sdlpa'
$flag = Join-Path $root 'data\NEED_MANUAL'
$last = $null
while ($true) {
  if (Test-Path $flag) {
    $body = (Get-Content $flag -Raw -ErrorAction SilentlyContinue)
    if ($body -and $body -ne $last) {
      $last = $body
      try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
        $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $t = $tpl.GetElementsByTagName('text')
        $t.Item(0).AppendChild($tpl.CreateTextNode('继续教育需要你点一下')) | Out-Null
        $t.Item(1).AppendChild($tpl.CreateTextNode('平台弹了图形签到，请在浏览器里完成后自动继续')) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('SDLPAAutoLearn').Show($toast)
      } catch { }
    }
  } else { $last = $null }
  Start-Sleep -Seconds 30
}
