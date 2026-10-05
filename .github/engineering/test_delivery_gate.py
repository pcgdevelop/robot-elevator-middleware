import copy, unittest
from delivery_gate import validate_pr, validate_issue_response

class TraceabilityTests(unittest.TestCase):
 def setUp(self):
  self.repo='pcgdevelop/pogastro-platform'
  self.pr={'title':'[#62] Establish delivery foundation','head':{'ref':'hermes/62-delivery-foundation'},'body':'Refs pcgdevelop/pogastro-platform#62\n\n'+''.join('## '+s+'\nConcrete verified result and a test artifact for this change.\n\n' for s in ('Acceptance criteria','Test evidence','Documentation','Risk and rollback'))}
 def test_complete(self): self.assertEqual([],validate_pr(self.pr,self.repo))
 def test_missing_ticket(self):
  self.pr['title']='Untracked work';self.assertTrue(validate_pr(self.pr,self.repo))
 def test_other_repository_does_not_satisfy_reference(self):
  self.pr['body']=self.pr['body'].replace(self.repo,'somewhere/else');self.assertTrue(validate_pr(self.pr,self.repo))
 def test_mismatched_issue(self):
  self.pr['body']=self.pr['body'].replace('#62','#63');self.assertTrue(validate_pr(self.pr,self.repo))
 def test_placeholder_rejected(self):
  self.pr['body']=self.pr['body'].replace('Concrete verified result','TODO unverified result');self.assertTrue(validate_pr(self.pr,self.repo))
 def test_empty_evidence(self):
  self.pr['body']=self.pr['body'].replace('## Test evidence\nConcrete verified result and a test artifact for this change.','## Test evidence\n');self.assertTrue(validate_pr(self.pr,self.repo))
 def test_branch_requires_ticket(self):
  self.pr['head']['ref']='hermes/something';self.assertTrue(validate_pr(self.pr,self.repo))
 def test_explicit_legacy_branch(self):
  self.pr['head']['ref']='hermes/free-address-20261004';self.assertEqual([],validate_pr(self.pr,self.repo,['hermes/free-address-20261004']))
 def test_untrusted_text_is_data(self):
  self.pr['body']+='\n$(echo harmless) `exit 9`';self.assertEqual([],validate_pr(self.pr,self.repo))
 def test_existing_issue(self): self.assertEqual([],validate_issue_response({'number':62},62))
 def test_pr_is_not_a_ticket(self): self.assertTrue(validate_issue_response({'number':62,'pull_request':{}},62))
 def test_wrong_issue_response(self): self.assertTrue(validate_issue_response({'number':63},62))

if __name__=='__main__': unittest.main()
