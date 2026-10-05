"""Validate Allsyn ticket traceability and documentation without running PR text."""
import json, os, re, subprocess, sys, urllib.request, urllib.error
from pathlib import Path

SECTIONS = ('Acceptance criteria', 'Test evidence', 'Documentation', 'Risk and rollback')

def validate_issue_response(issue, number):
 if issue.get('number') != number or 'pull_request' in issue:
  return ['Ticket reference must point to an existing issue, not a pull request.']
 return []

def validate_pr(pr, repository, legacy_branches=()):
 errors=[]
 title=pr.get('title',''); body=pr.get('body') or ''
 match=re.search(r'\[#([1-9][0-9]*)\]',title)
 if not match: errors.append('PR title must start with a local ticket reference, e.g. [#123].')
 elif not title.startswith(match.group(0)): errors.append('Ticket reference must lead the title.')
 if match:
  number=match.group(1)
  if not re.search(r'(?:Refs|Closes|Fixes)\s+(?:'+re.escape(repository)+r')?#'+number+r'\b',body,re.I):
   errors.append('Body must explicitly reference the same repository issue as the title.')
  branch=pr.get('head',{}).get('ref','')
  if branch not in legacy_branches and not re.match(r'(?:hermes|feature|fix|docs|chore)/'+number+r'-[a-z0-9-]+$',branch):
   errors.append('New branch must include the ticket number: hermes/123-short-name.')
 for section in SECTIONS:
  found=re.search(r'^## '+re.escape(section)+r'\s*\n(.*?)(?=^## |\Z)',body,re.M|re.S)
  if not found or len(found.group(1).strip())<25:
   errors.append('Missing concrete section: '+section)
  elif re.search(r'\b(TBD|TODO|PLACEHOLDER|INSERT HERE)\b',found.group(1),re.I):
   errors.append('Unresolved placeholder in '+section)
 return errors

def validate_catalog(root):
 errors=[]
 required=['AGENTS.md','docs/engineering-standard/development.md','docs/engineering-standard/features.md','docs/engineering-standard/handbook.md','docs/engineering-standard/acceptance-matrix.md','docs/engineering-standard/release.md','docs/engineering-standard/wiki/Home.md','docs/engineering-standard/adr/0001-delivery-system.md','.github/ISSUE_TEMPLATE/engineering-story.yml','.github/ISSUE_TEMPLATE/engineering-bug.yml','.github/PULL_REQUEST_TEMPLATE/engineering-standard.md']
 for name in required:
  if not (root/name).is_file(): errors.append('Missing delivery artifact: '+name)
 catalog=json.loads((root/'docs/engineering-standard/feature-catalog.json').read_text('utf-8'))
 handbook=(root/'docs/engineering-standard/handbook.md').read_text('utf-8')
 seen=set()
 for f in catalog['features']:
  if f['id'] in seen: errors.append('Duplicate feature ID: '+f['id'])
  seen.add(f['id'])
  if not (root/f['source']).exists(): errors.append('Invalid source anchor: '+f['source'])
  if not re.fullmatch(re.escape(catalog['repository'])+r'#[1-9][0-9]*',f['ticket']): errors.append('Invalid ticket for '+f['id'])
  if '## '+f['id']+' —' not in handbook: errors.append('Feature missing from handbook: '+f['id'])
 return errors

def main():
 root=Path.cwd(); errors=validate_catalog(root)
 config=json.loads((root/'.github/engineering/traceability.json').read_text('utf-8'))
 event=Path(os.environ['GITHUB_EVENT_PATH']) if os.getenv('GITHUB_EVENT_PATH') else None
 if event:
  data=json.loads(event.read_text('utf-8'))
  if 'pull_request' in data:
   errors += validate_pr(data['pull_request'],config['repository'],config.get('legacy_branches',[]))
   match=re.search(r'^\[#([1-9][0-9]*)\]',data['pull_request'].get('title',''))
   if match:
    number=int(match.group(1))
    record=root/'docs'/'engineering-standard'/'acceptance'/('issue-'+str(number)+'.md')
    if not record.is_file(): errors.append('Missing per-ticket acceptance record: '+str(record.relative_to(root)))
    token=os.environ.get('GH_TOKEN','')
    if not token: errors.append('CI requires its own read-only token to verify the referenced issue.')
    else:
     request=urllib.request.Request('https://api.github.com/repos/'+config['repository']+'/issues/'+str(number),headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
     try:
      with urllib.request.urlopen(request,timeout=20) as response:
       errors += validate_issue_response(json.load(response),number)
     except (urllib.error.URLError,ValueError): errors.append('Referenced issue could not be verified; refusing to mark traceability as passed.')
   # Compare tracked files only. No untrusted input is passed to a shell.
   base=data['pull_request']['base']['sha'];head=data['pull_request']['head']['sha']
   if not re.fullmatch(r'[0-9a-f]{40}',base) or not re.fullmatch(r'[0-9a-f]{40}',head):
    errors.append('Invalid commit reference.')
   else:
    names=subprocess.check_output(['git','diff','--name-only',base,head],text=True).splitlines()
    code=[n for n in names if n.endswith(('.js','.ts','.jsx','.vue','.jade','.html','.scss','.sql')) and not n.startswith('.github/')]
    if code and not any(n.startswith('docs/engineering-standard/') for n in names):
     errors.append('Behavior/source changes require an updated specification or acceptance record under docs/engineering-standard/.')
 if errors:
  print('\n'.join('ERROR: '+e for e in errors));return 1
 print('PASS: ticket/documentation foundation. This is not a full application build or browser acceptance.')
 return 0

if __name__=='__main__': sys.exit(main())
