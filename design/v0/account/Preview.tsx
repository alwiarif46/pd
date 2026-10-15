import { AccountPage } from './AccountPage';
export default function Preview() { return <AccountPage name="Dana Reyes" email="dana.reyes@northbridge-gov.com" phone="+1 (202) 555-0148" profileStatus="idle" passwordStatus="idle" onSaveName={console.log} onChangePassword={console.log} />; }
