import os,json,urllib.request
from pathlib import Path

class C:
    def __init__(self,u=None,k=None):
        self.u=u or os.environ.get('LLM_URL','http://localhost:8080/v1/chat/completions')
        self.k=k or os.environ.get('LLM_KEY','')
        self.t=int(os.environ.get('LLM_TIMEOUT','30'))

    def q(self,p,m='gpt-4',temp=.7,max_t=4096):
        d={'model':m,'messages':[{'role':'user','content':p}],'temperature':temp,'max_tokens':max_t}
        b=json.dumps(d).encode()
        h={'Content-Type':'application/json'}
        if self.k:h['Authorization']=f'Bearer {self.k}'
        req=urllib.request.Request(self.u,data=b,headers=h,method='POST')
        try:
            with urllib.request.urlopen(req,timeout=self.t) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            return{'e':str(e)}

    def complete(self,p,m=None):
        r=self.q(p,m or os.environ.get('LLM_MODEL','gpt-4'))
        return r.get('choices',[{}])[0].get('message',{}).get('content','') if 'choices' in r else str(r.get('e',''))

if __name__=='__main__':
    import sys
    c=C()
    print(c.complete(sys.argv[1] if len(sys.argv)>1 else 'hello'))
