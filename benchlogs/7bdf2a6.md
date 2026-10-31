# Benchmark 7bdf2a6

Date: 2026-10-31T14:53:15.223Z

## Results

| Name                            | Native ops/s | Shared ops/s | Ratio   |
| ------------------------------- | ------------ | ------------ | ------- |
| number · read                   | 423504500    | 53930160     | 7.85×   |
| number · write                  | 461271634    | 16530407     | 27.90×  |
| string · read                   | 421793212    | 43568239     | 9.68×   |
| string · write                  | 346824819    | 13435587     | 25.81×  |
| boolean · read                  | 292611558    | 79888157     | 3.66×   |
| boolean · write                 | 926998841    | 14936799     | 62.06×  |
| bigint · read                   | 485436893    | 88987764     | 5.46×   |
| bigint · write                  | 390751689    | 13138590     | 29.74×  |
| number[] · read index           | 548946845    | 31209769     | 17.59×  |
| number[] · write index          | 428632662    | 4826068      | 88.82×  |
| number[] · push                 | 250000000    | 2483442      | 100.67× |
| number[] · pop                  | 436300175    | 4083716      | 106.84× |
| string[] · read index           | 541395067    | 38942069     | 13.90×  |
| string[] · write index          | 421052632    | 9104732      | 46.25×  |
| string[] · push                 | 186046512    | 5909886      | 31.48×  |
| string[] · pop                  | 393391031    | 5692589      | 69.11×  |
| boolean[] · read index          | 489696780    | 37987311     | 12.89×  |
| boolean[] · write index         | 470588235    | 11320669     | 41.57×  |
| boolean[] · push                | 175162025    | 7270506      | 24.09×  |
| boolean[] · pop                 | 470588235    | 9650181      | 48.76×  |
| bigint[] · read index           | 527123120    | 39365553     | 13.39×  |
| bigint[] · write index          | 324359390    | 10434819     | 31.08×  |
| bigint[] · push                 | 190476190    | 7192071      | 26.48×  |
| bigint[] · pop                  | 380952381    | 6861063      | 55.52×  |
| mixed[] · read index            | 567375887    | 68571444     | 8.27×   |
| mixed[] · write index           | 393391031    | 10978877     | 35.83×  |
| mixed[] · push                  | 226449275    | 2120702      | 106.78× |
| mixed[] · pop                   | 400000000    | 8720905      | 45.87×  |
| object · read number prop       | 733718780    | 30264823     | 24.24×  |
| object · read string prop       | 645506949    | 26440743     | 24.41×  |
| object · read boolean prop      | 626468285    | 25154069     | 24.91×  |
| object · read bigint prop       | 626468285    | 28448822     | 22.02×  |
| object · write number prop      | 602710994    | 16565778     | 36.38×  |
| object · write string prop      | 428449015    | 12263769     | 34.94×  |
| object · read array prop index  | 537755837    | 14972956     | 35.92×  |
| object · write array prop index | 413736036    | 4358096      | 94.94×  |
| object · array prop push        | 126310471    | 3167474      | 39.88×  |
| native vs cached shared read    | 658237280    | 26267258     | 25.06×  |

## Summary

- Reads: 16.4× slower (min 3.7×, max 25.1×)
- Array reads: 17.0× slower (min 8.3×, max 35.9×)
- Writes: 36.1× slower (min 25.8×, max 62.1×)
- Array writes: 58.5× slower (min 24.1×, max 106.8×)
