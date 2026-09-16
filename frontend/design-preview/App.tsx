import { useEffect, useRef, useState } from 'react';
import { Button } from '@openai/apps-sdk-ui/components/Button';
import { Input } from '@openai/apps-sdk-ui/components/Input';
import { Badge } from '@openai/apps-sdk-ui/components/Badge';
import { Checkbox } from '@openai/apps-sdk-ui/components/Checkbox';
import { Popover } from '@openai/apps-sdk-ui/components/Popover';
import { Slider } from '@openai/apps-sdk-ui/components/Slider';
import { ArrowRight, AvatarProfile, Check, Clock, Code, Cube, Folder, Globe, Grid, InfoCircle, Search, SettingsCog, SettingsSlider, Sun, Warning } from '@openai/apps-sdk-ui/components/Icon';

const templates = [
  { name: '웹 앱', id: 'web-app', Icon: Globe, description: '웹 서버를 간단하게 배포합니다.', resources: [['Deployment', '웹 서버 실행'], ['Service', '앱 내부 연결'], ['ConfigMap', '앱 설정 관리']] },
  { name: '설정 있는 앱', id: 'app-with-config', Icon: SettingsCog, description: '환경 설정과 비밀 값을 함께 관리합니다.', resources: [['Deployment', '앱 실행'], ['ConfigMap', '환경 설정'], ['Secret', '비밀 값 관리']] },
  { name: '야간 배치', id: 'nightly-job', Icon: Clock, description: '정해진 시간에 반복 작업을 실행합니다.', resources: [['CronJob', '예약된 작업 실행']] },
];
const colors = [['Sidebar', '#EDF5F3'], ['Navigation', '#DFEAE8'], ['Selection', '#EAF3FD'], ['Text', '#373E40'], ['Focus', '#2563EB']];

// Apps SDK UI 0.2.2 labels the numeric field but not its separate slider thumb.
// Keep the official control; bridge its accessible name until upstream exposes it.
function nameSliderThumb(node: HTMLSpanElement | null) {
  node?.querySelector('[role="slider"]')?.setAttribute('aria-label', '실행 수량');
}

export function App() {
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState('light');
  const [cluster, setCluster] = useState('oci-a1');
  const [namespace, setNamespace] = useState('demo');
  const [section, setSection] = useState('catalog');
  const [name, setName] = useState('');
  const [replicas, setReplicas] = useState(2);
  const [feedback, setFeedback] = useState('버튼을 누르면 여기에 결과가 표시됩니다.');
  const [result, setResult] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const template = templates[selected];
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const matches = templates.map((t, i) => ({ ...t, i })).filter(t => `${t.name} ${t.id} ${t.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <aside className="sidebar"><a className="brand" href="#catalog">kubeport <span>design lab</span></a>
      <nav aria-label="시안 탐색">{[['catalog', '카탈로그 시안', Grid], ['components', '컴포넌트', Code], ['principles', '디자인 기준', SettingsCog]].map(([id, title, Icon]) => {
        const NavIcon = Icon as typeof Grid;
        return <a key={id as string} href={`#${id}`} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id as string)}><NavIcon aria-hidden />{title as string}</a>;
      })}</nav><div className="sidebar-bottom"><p><Cube aria-hidden />{cluster}<small>예시 환경</small></p><p><AvatarProfile aria-hidden />디자인 미리보기</p></div>
    </aside>
    <div className="workspace"><header className="topbar"><span>디자인 실험실 <span className="muted">/ Mint workspace</span></span><div className="toolbar">
      <Button color="secondary" variant="ghost" size="lg" aria-label={theme === 'light' ? '어두운 테마로 전환' : '밝은 테마로 전환'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><Sun /></Button>
      <Popover><Popover.Trigger><Button color="secondary" variant="ghost" size="lg" aria-label="환경 메뉴"><SettingsSlider /></Button></Popover.Trigger><Popover.Content align="end" width={300} minWidth="auto" className="environment"><h2>미리보기 환경</h2>
        <label><Cube aria-hidden />클러스터<select value={cluster} onChange={e => setCluster(e.target.value)}><option>oci-a1</option><option>staging</option></select></label>
        <label><Folder aria-hidden />배포 구역<select value={namespace} onChange={e => setNamespace(e.target.value)}><option>demo</option><option>sandbox</option></select></label><hr />
        <label><Sun aria-hidden />테마<select value={theme} onChange={e => setTheme(e.target.value)}><option value="light">라이트</option><option value="dark">다크</option></select></label><p className="muted">이 메뉴는 미리보기만 변경합니다.</p>
      </Popover.Content></Popover>
    </div></header>
    <main><section id="catalog" className="page-section"><div className="eyebrow">A QUIETER WAY TO DEPLOY</div><h1>템플릿 선택</h1><p className="intro">배포할 앱의 구성을 확인하세요.</p><p className="preview-note"><InfoCircle aria-hidden />디자인 시안입니다. 실제 클러스터에 연결되지 않습니다.</p>
    <div className="catalog-layout"><div><Input size="xl" aria-label="템플릿 검색" placeholder="템플릿 검색" startAdornment={<Search />} value={query} onChange={e => setQuery(e.target.value)} /><div className="template-list">{matches.map(t => <button key={t.id} className="template" aria-pressed={selected === t.i} onClick={() => setSelected(t.i)}><t.Icon aria-hidden /><span><strong>{t.name}</strong><small>{t.id}</small></span></button>)}</div>{matches.length === 0 && <p className="muted" role="status">검색 결과가 없어요. 다른 이름으로 찾아보세요.</p>}</div>
      <article className="detail"><div className="detail-title"><template.Icon aria-hidden /><div><h2>{template.name}</h2><p className="muted">{template.id} · v1</p></div></div><p>{template.description}</p><h3>배포 구성</h3>{template.resources.map(([title, text]) => <div className="resource" key={title}><Cube aria-hidden /><div>{title}<p>{text}</p></div></div>)}<div className="notice"><InfoCircle aria-hidden />다음 단계에서 이름과 배포 구역을 설정합니다.</div><Button color="primary" size="lg" onClick={() => { form.current?.reset(); setResult(''); dialog.current?.showModal(); }}>이 템플릿으로 배포 연습<ArrowRight /></Button></article>
    </div></section>
    <section id="components" className="page-section"><div className="eyebrow">OPENAI APPS SDK UI · 0.2.2</div><h2>공식 컴포넌트를 그대로, 우리 화면에</h2><p className="intro">아래 버튼·입력·체크박스·슬라이더·배지와 상단 팝오버는 OpenAI 패키지입니다.</p><div className="specimen"><h3>버튼과 피드백</h3><div className="row"><Button color="primary" onClick={() => setFeedback('저장 완료 상태의 예시입니다. 실제 설정은 저장되지 않았어요.')}>변경 저장<Check /></Button><Button color="secondary" variant="outline" onClick={() => { setName(''); setFeedback('앱 이름 입력을 초기화했어요.'); }}>입력 초기화</Button><Button color="secondary" disabled>비활성 버튼</Button><Button color="danger" variant="soft" onClick={() => setFeedback('오류 예시: 연결을 확인할 수 없어요. 환경을 확인한 뒤 다시 시도하세요.')}>오류 피드백 보기</Button></div><p role="status">{feedback}</p></div>
      <div className="specimen form-grid"><div><h3>입력</h3><label htmlFor="sample-name">앱 이름</label><Input id="sample-name" size="xl" placeholder="my-web-app" value={name} onChange={e => setName(e.target.value)} /><p className="muted">예: 영문 소문자·숫자·하이픈</p></div><div><h3>수량과 옵션</h3><Slider ref={nameSliderThumb} label="실행 수량" value={replicas} min={1} max={5} step={1} onChange={setReplicas} /><div className="checkbox-example"><Checkbox label="자동으로 상태 새로고침" defaultChecked /></div></div></div>
      <div className="specimen"><h3>상태 표시</h3><div className="row"><Badge color="success"><Check />정상</Badge><Badge color="warning"><Clock />준비 중</Badge><Badge color="danger"><Warning />확인 필요</Badge><Badge color="secondary"><InfoCircle />상태 미확인</Badge></div><p className="muted">상태는 색상과 아이콘·문장으로 함께 구분합니다.</p></div>
    </section>
    <section id="principles" className="page-section"><div className="eyebrow">DESIGN DIRECTION · 2026.09.16</div><h2>민트빛 여백, 또렷한 행동</h2><p className="intro">옅은 민트 사이드바와 청회색 선택 배경. 흰 화면 위에 필요한 메뉴만 가볍게 띄웁니다.</p><div className="swatches">{colors.map(([label, color]) => <div key={label}><span style={{ background: color }} />{label}<code>{color}</code></div>)}</div><div className="specimen"><h3>재사용의 경계</h3><p>OpenAI: 버튼, 입력, 팝오버, 체크박스, 슬라이더, 배지, 아이콘과 기본 토큰.</p><p>kubeport: 민트 사이드바, 카탈로그 배치, 템플릿 선택 상태, 업무 문구와 미리보기 데이터.</p><p>첨부된 Codex 화면에서 영감을 받은 시안이며, Codex 내부 UI 소스와 동일하다는 의미는 아닙니다. 다크 모드는 이 시안에서 확장한 제안입니다.</p><a className="text-link" href="https://openai.github.io/apps-sdk-ui/">OpenAI 공식 컴포넌트 문서 보기 →</a></div></section>
    </main><footer>kubeport design lab · 실제 배포·설정 저장 없이 조작하는 독립 시안</footer></div>
    <dialog ref={dialog} aria-labelledby="deploy-title"><form ref={form} onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); setResult(`연습 완료: ${data.get('appName')} / ${namespace}. 실제 리소스는 생성하지 않았어요.`); }}><h2 id="deploy-title">배포 연습</h2><p>{template.name} · {cluster} / {namespace}</p><label htmlFor="deploy-name">앱 이름</label><Input id="deploy-name" size="xl" name="appName" required pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" maxLength={63} placeholder="my-web-app" aria-describedby="name-help" /><p id="name-help" className="muted">영문 소문자·숫자·하이픈을 사용하세요. 처음과 끝에는 하이픈을 쓸 수 없습니다.</p><p className="notice">실제 리소스를 생성하지 않습니다.</p><div className="row"><Button color="primary" type="submit">배포 연습 완료</Button><Button color="secondary" variant="outline" type="button" onClick={() => dialog.current?.close()}>닫기</Button></div><p role="status">{result}</p></form></dialog>
  </>;
}



