# One-time icon generator: draws the Automatic-Task icon (rounded gradient
# tile, white "AT", green checkmark) at every required size and packs the
# PNGs into icons/autotask.ico.
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$outDir = Join-Path $root "icons"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function New-IconPng {
    param([int]$Size, [string]$OutFile)
    $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded tile with an indigo -> violet gradient.
    $pad = [Math]::Max(1, [int]($Size * 0.05))
    $radius = [Math]::Max(3, [int]($Size * 0.20))
    $w = $Size - 2 * $pad
    $rect = [System.Drawing.Rectangle]::new($pad, $pad, $w, $w)
    $gp = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = 2 * $radius
    $gp.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $gp.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $gp.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $gp.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $gp.CloseFigure()

    $c1 = [System.Drawing.Color]::FromArgb(255, 17, 24, 39)    # near-black
    $c2 = [System.Drawing.Color]::FromArgb(255, 107, 114, 128) # gray-500
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $c1, $c2, 135.0)
    $g.FillPath($brush, $gp)
    $brush.Dispose()

    # Everything is centered on the tile's center point.
    $cx = $Size * 0.5
    $cy = $Size * 0.5

    # Simple centered ring with a checkmark - no teeth.
    $ringR = $Size * 0.29
    $ringPenWidth = [Math]::Max(2.0, $Size * 0.10)
    $ringPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, [Single]$ringPenWidth)
    $g.DrawEllipse($ringPen, $cx - $ringR, $cy - $ringR, 2 * $ringR, 2 * $ringR)
    $ringPen.Dispose()

    # Light-gray checkmark centered inside the ring.
    $checkWidth = [Math]::Max(1.8, $Size * 0.11)
    $checkPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 226, 232, 240), [Single]$checkWidth)
    $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawLine($checkPen, $cx - $Size * 0.11, $cy + $Size * 0.02, $cx - $Size * 0.03, $cy + $Size * 0.10)
    $g.DrawLine($checkPen, $cx - $Size * 0.03, $cy + $Size * 0.10, $cx + $Size * 0.13, $cy - $Size * 0.08)
    $checkPen.Dispose()

    $g.Dispose()
    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $sizes) {
    $png = Join-Path $env:TEMP ("at-icon-$s.png")
    New-IconPng -Size $s -OutFile $png
    $pngs += $png
}

$count = $pngs.Length
$headerSize = 6 + 16 * $count
$stream = [System.IO.File]::Create((Join-Path $outDir "autotask.ico"))
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$count)
$offset = $headerSize
foreach ($png in $pngs) {
    $data = [System.IO.File]::ReadAllBytes($png)
    $index = [Array]::IndexOf($pngs, $png)
    $size = $sizes[$index]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$data.Length)
    $writer.Write([UInt32]$offset)
    $offset += $data.Length
}
foreach ($png in $pngs) {
    $data = [System.IO.File]::ReadAllBytes($png)
    $writer.Write([byte[]]$data)
}
$writer.Close()
$stream.Dispose()
foreach ($png in $pngs) {
    Remove-Item $png -Force
}
Write-Output "Generated $(Join-Path $outDir 'autotask.ico')"
