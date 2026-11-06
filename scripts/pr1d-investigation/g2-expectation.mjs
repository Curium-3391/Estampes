// Oracle only for the unchanged two-step R3-B1 G2 fixture, not general GC policy.
export function expectedFixtureG2State(progress,clock){
 const eligible=progress?.quarantinedAtMs!==null&&Number.isSafeInteger(progress?.quarantinedAtMs)&&clock.canAge&&clock.nowMs>=progress.quarantinedAtMs+86400000;
 return eligible?'complete':'waiting-grace';
}
