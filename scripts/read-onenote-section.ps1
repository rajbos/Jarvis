<#
.SYNOPSIS
  Read a OneNote .one section file via COM and output page content as JSON.
.PARAMETER FilePath
  Absolute path to the .one section file.
.OUTPUTS
  JSON written to stdout: { ok: true, pages: [{ pageIndex, title, date, content }] }
  On failure:           { ok: false, error: "<message>" }
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

function ConvertTo-SafeJson([object]$value) {
  return $value | ConvertTo-Json -Depth 5 -Compress
}

try {
  if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-Output (ConvertTo-SafeJson @{ ok = $false; error = "File not found: $FilePath" })
    exit 1
  }

  $onenote = New-Object -ComObject OneNote.Application

  # Derive section name from file path
  $sectionName = [System.IO.Path]::GetFileNameWithoutExtension($FilePath)

  # OpenHierarchy - CreateFileType.cftNone = 0
  $sectionId = [string]''
  $onenote.OpenHierarchy($FilePath, [string]'', [ref]$sectionId, 0)

  if ([string]::IsNullOrEmpty($sectionId)) {
    Write-Output (ConvertTo-SafeJson @{ ok = $false; error = "Failed to resolve section ID for: $FilePath" })
    exit 1
  }

  # GetHierarchy - HierarchyScope.hsPages = 4
  $hierXml = [string]''
  $onenote.GetHierarchy($sectionId, 4, [ref]$hierXml)

  [xml]$hier = $hierXml

  # Detect namespace from document root; fall back to 2013 schema
  $rootNs = $hier.DocumentElement.NamespaceURI
  if ([string]::IsNullOrEmpty($rootNs)) {
    $rootNs = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
  }
  $nsMgr = New-Object System.Xml.XmlNamespaceManager($hier.NameTable)
  $nsMgr.AddNamespace('one', $rootNs)

  $pageNodes = $hier.SelectNodes('//one:Page', $nsMgr)

  $pages = [System.Collections.Generic.List[hashtable]]::new()
  $pageIndex = 0

  foreach ($pageNode in $pageNodes) {
    $pageIndex++
    $pageId       = $pageNode.GetAttribute('ID')
    $pageName     = $pageNode.GetAttribute('name')
    $pageDateTime = $pageNode.GetAttribute('dateTime')
  $pageLevelStr = $pageNode.GetAttribute('pageLevel')
  if ($null -eq $pageName)     { $pageName = '' }
  if ($null -eq $pageDateTime) { $pageDateTime = '' }
  [int]$pageLevel = if (-not [string]::IsNullOrEmpty($pageLevelStr)) { [int]$pageLevelStr } else { 1 }

    # GetPageContent - PageDetail.pdBasic = 0
    $contentXml = [string]''
    try {
      $onenote.GetPageContent($pageId, [ref]$contentXml, 0)
    } catch {
      # Non-fatal: page content unreadable; continue with empty text
    }

    $textContent = ''
    if (-not [string]::IsNullOrEmpty($contentXml)) {
      try {
        [xml]$content = $contentXml
        $cNs = $content.DocumentElement.NamespaceURI
        if ([string]::IsNullOrEmpty($cNs)) { $cNs = $rootNs }
        $cMgr = New-Object System.Xml.XmlNamespaceManager($content.NameTable)
        $cMgr.AddNamespace('one', $cNs)

        $tNodes = $content.SelectNodes('//one:T', $cMgr)
        $parts  = [System.Collections.Generic.List[string]]::new()
        foreach ($t in $tNodes) {
          $inner = $t.InnerText.Trim()
          if ($inner.Length -gt 0) { $parts.Add($inner) }
        }
        $textContent = $parts -join ' '
      } catch {
        $textContent = ''
      }
    }

    $pages.Add(@{
      pageIndex = $pageIndex
      pageLevel = $pageLevel
      title     = $pageName
      date      = $pageDateTime
      content   = $textContent
    })
  }

  Write-Output (ConvertTo-SafeJson @{ ok = $true; sectionName = $sectionName; pages = $pages.ToArray() })
  exit 0

} catch {
  Write-Output (ConvertTo-SafeJson @{ ok = $false; error = $_.Exception.Message })
  exit 1
}
