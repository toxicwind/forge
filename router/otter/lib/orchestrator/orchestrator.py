import os,json,subprocess,time
from pathlib import Path

def R(c,t=3):
    try:
        p=subprocess.run(c,shell=True,capture_output=True,text=True,timeout=t)
        return{'o':p.stdout,'e':p.stderr,'r':p.returncode}
    except Exception as e:
        return{'o':'','e':str(e),'r':-1}

def health(url='http://localhost:8888/health',t=2):
    return R(f'curl -s -m {t} {url}',t+1)

def detect_env():
    r=[]
    if Path('/proc/self/cgroup').exists():
        with open('/proc/self/cgroup') as f:
            if 'kubepods' in f.read():r.append('k8s')
    if Path('/run/service').exists():r.append('s6')
    if Path('/.dockerenv').exists():r.append('docker')
    return r

def restart_kernel(path='/app/kernel_server.py',port=8888,t=30):
    env=os.environ.copy()
    env['PYTHONUNBUFFERED']='1'
    log=Path('/tmp/kernel_restart.log')
    with open(log,'w') as f:
        p=subprocess.Popen(['python3',path,'--host','0.0.0.0','--port',str(port),'--log-level','info'],
            cwd='/mnt/agents',env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
    for i in range(t):
        h=health()
        if 'kernel_alive' in h.get('o',''):
            return{'ok':True,'pid':p.pid}
        time.sleep(1)
    return{'ok':False,'pid':p.pid}

if __name__=='__main__':
    print(json.dumps({'env':detect_env(),'health':health()},indent=2))
