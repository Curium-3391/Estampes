// ANALYTICAL capacity model only. No production imports, writes or benchmark claims.
const KiB=1024,MiB=KiB**2,GiB=KiB**3;
const S=64*MiB,delta=2*KiB,days=365;
const gib=bytes=>Number((bytes/GiB).toFixed(6));
const scenarios=[1000,10000,100000].map(commandsPerDay=>{
 const commands=commandsPerDay*days,history=commands*delta;
 const operationalCheckpointCopies=Math.floor(commands/1000);
 const archiveAnchorCopies=Math.ceil(history/(32*MiB));
 const components={losslessDelta:history,permanentTombstones:commands*KiB,
  fullAckWindow:Math.min(days,7)*commandsPerDay*64*KiB,
  archiveAnchorCheckpoints:archiveAnchorCopies*S};
 return {commandsPerDay,days,commands,componentsGiB:Object.fromEntries(Object.entries(components).map(([k,v])=>[k,gib(v)])),
  modeledPersistentGiB:gib(Object.values(components).reduce((a,b)=>a+b,0)),
  previousAllOperationalCheckpointsGiB:gib(operationalCheckpointCopies*S),
  previous24hFullCopyGiB:gib(commandsPerDay*S),
  exceeds10GiBBeforeAssetsPinsStagingAndIndices:Object.values(components).reduce((a,b)=>a+b,0)>10*GiB};
});
process.stdout.write(JSON.stringify({classification:'ANALYTICAL_NOT_MEASURED',assumptions:{documentBytes:S,deltaBytesPerCommand:delta,tombstoneMaxBytes:KiB,ackMaxBytes:64*KiB,ackDays:7,archiveAnchorDeltaBytes:32*MiB,operationalCommands:1000,quotaGiB:10},limitations:'Component model using fixed assumed sizes. Omits assets, full ACK artifacts, indices, journal, active reader pins, staged/maintenance/backup workspace and variable compression. Not an upper bound, runtime throughput, capacity SLA or measured retention performance. Real full-document replacement can have delta approximately S and is not deduplicated away.',scenarios},null,2)+'\n');
