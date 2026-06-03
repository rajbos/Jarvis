<#
.SYNOPSIS
  Read all sections and pages of an open OneNote notebook via COM.
.PARAMETER NotebookName
  Display name of the notebook (case-insensitive match).
.PARAMETER OutputPath
  Optional path to write JSON output to (instead of stdout). Useful for large notebooks.
.OUTPUTS
  JSON to stdout or file:
    { ok: true, notebookName: string, sections: [{ sectionName, pages: [{ pageIndex, pageLevel, title, date, lastModified, content }] }] }
    { ok: false, error: string }
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$NotebookName,
  
  [Parameter(Mandatory = $false)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

function ConvertTo-SafeJson([object]$value) {
  return $value | ConvertTo-Json -Depth 10 -Compress
}

try {
  $onenote = New-Object -ComObject OneNote.Application

  # Get full hierarchy (notebooks → sections → pages) in one call.
  # HierarchyScope: hsPages = 4
  $hierXml = [string]''
  $onenote.GetHierarchy([string]'', 4, [ref]$hierXml)

  [xml]$hier = $hierXml

  $rootNs = $hier.DocumentElement.NamespaceURI
  if ([string]::IsNullOrEmpty($rootNs)) {
    $rootNs = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
  }
  $nsMgr = New-Object System.Xml.XmlNamespaceManager($hier.NameTable)
  $nsMgr.AddNamespace('one', $rootNs)

  # Find the notebook (case-insensitive).
  $notebookNode = $null
  $allNotebooks = $hier.SelectNodes('//one:Notebook', $nsMgr)
  $availableNames = [System.Collections.Generic.List[string]]::new()
  foreach ($nb in $allNotebooks) {
    $availableNames.Add($nb.GetAttribute('name'))
    if ($nb.GetAttribute('name') -ieq $NotebookName) {
      $notebookNode = $nb
      break
    }
  }

  if ($null -eq $notebookNode) {
    Write-Output (ConvertTo-SafeJson @{
      ok    = $false
      error = "Notebook '$NotebookName' not found in open notebooks. Available: $($availableNames -join '; ')"
    })
    exit 1
  }

  $resolvedName = $notebookNode.GetAttribute('name')
  $sections = [System.Collections.Generic.List[hashtable]]::new()

  # Collect all sections (including those inside section groups).
  $sectionNodes = $notebookNode.SelectNodes('.//one:Section', $nsMgr)

  foreach ($sectionNode in $sectionNodes) {
    $sectionName  = $sectionNode.GetAttribute('name')
    $sectionReadOnly = $sectionNode.GetAttribute('readOnly')
    # Skip recycle bin
    if ($sectionNode.GetAttribute('isInRecycleBin') -eq 'true') { continue }

    $pageNodes = $sectionNode.SelectNodes('one:Page', $nsMgr)
    $pages = [System.Collections.Generic.List[hashtable]]::new()
    $pageIndex = 0

    foreach ($pageNode in $pageNodes) {
      $pageIndex++
      $pageId           = $pageNode.GetAttribute('ID')
      $pageName         = $pageNode.GetAttribute('name')
      $pageDateTime     = $pageNode.GetAttribute('dateTime')
      $pageLastModified = $pageNode.GetAttribute('lastModifiedTime')
      $pageLevelStr     = $pageNode.GetAttribute('pageLevel')
      if ($null -eq $pageName)         { $pageName = '' }
      if ($null -eq $pageDateTime)     { $pageDateTime = '' }
      if ($null -eq $pageLastModified) { $pageLastModified = '' }
      [int]$pageLevel = if (-not [string]::IsNullOrEmpty($pageLevelStr)) { [int]$pageLevelStr } else { 1 }

      $textContent = ''
      if (-not [string]::IsNullOrEmpty($pageId)) {
        $contentXml = [string]''
        try {
          $onenote.GetPageContent($pageId, [ref]$contentXml, 0)
          if (-not [string]::IsNullOrEmpty($contentXml)) {
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
          }
        } catch {
          # Non-fatal: page content unreadable; continue with empty text
        }
      }

      $pages.Add(@{
        pageIndex    = $pageIndex
        pageLevel    = $pageLevel
        title        = $pageName
        date         = $pageDateTime
        lastModified = $pageLastModified
        content      = $textContent
      })
    }

    $sections.Add(@{
      sectionName = $sectionName
      pages       = $pages.ToArray()
    })
  }

  $resultJson = ConvertTo-SafeJson @{
    ok           = $true
    notebookName = $resolvedName
    sections     = $sections.ToArray()
  }
  
  if ([string]::IsNullOrEmpty($OutputPath)) {
    Write-Output $resultJson
  } else {
    $resultJson | Out-File -FilePath $OutputPath -Encoding UTF8 -Force
  }
  exit 0

} catch {
  $errorJson = ConvertTo-SafeJson @{ ok = $false; error = $_.Exception.Message }
  if ([string]::IsNullOrEmpty($OutputPath)) {
    Write-Output $errorJson
  } else {
    $errorJson | Out-File -FilePath $OutputPath -Encoding UTF8 -Force
  }
  exit 1
}
