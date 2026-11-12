# 临时值域扫描驱动(task-41)。用完即删。
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\Administrator\Documents\deepseek-harness\default-workspace\2_5d_sandbox'
Set-Location $root

$baseline = (Get-FileHash server\src\coop\rush_order.ts -Algorithm SHA256).Hash
Write-Output "基线 SHA-256: $baseline"
Write-Output ""

function Scan([string]$const, [string[]]$values) {
  Write-Output "═══ 扫描 $const ═══"
  $orig = (node _mb_patch.ts show $const) -split '=',2 | Select-Object -Last 1
  $orig = $orig.Trim()
  foreach ($v in $values) {
    node _mb_patch.ts set $const $v | Out-Null
    $out = node tests/WS-11.test.ts 2>&1
    $reds = @($out | Select-String -Pattern '✗').Count
    $mark = if ($reds -gt 0) { '红' } else { '绿  <== 盲区' }
    Write-Output ("  {0,5} => 红条目={1,-3} [{2}]" -f $v, $reds, $mark)
  }
  node _mb_patch.ts set $const $orig | Out-Null
  $h = (Get-FileHash server\src\coop\rush_order.ts -Algorithm SHA256).Hash
  $ok = if ($h -eq $baseline) { '还原OK' } else { '!!还原失败' }
  Write-Output "  还原 -> $orig  [$ok]"
  Write-Output ""
}

Scan 'ORDER_SLOT_MIN' @('1','2','3','4','5','6')
Scan 'ORDER_SLOT_MAX' @('2','3','4','5','8')
Scan 'RUSH_ORDER_DURATION_SEC' @('2','60','179','180','181','360')
Scan 'OVERHEAT_SEC' @('1','6','11','12','13','30')
Scan 'EXTINGUISH_SEC' @('0.1','0.25','0.5','1','3')

$final = (Get-FileHash server\src\coop\rush_order.ts -Algorithm SHA256).Hash
Write-Output "最终 SHA-256: $final"
if ($final -eq $baseline) { Write-Output 'OK 与基线一致' } else { Write-Output 'FAIL 与基线不一致' }
