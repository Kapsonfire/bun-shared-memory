# Benchmark 34ac1eb

Date: 2026-10-31T14:53:07.967Z

## Results

| Name                            | Native ops/s | Shared ops/s | Ratio   |
| ------------------------------- | ------------ | ------------ | ------- |
| number · read                   | 355450658    | 54252001     | 6.55×   |
| number · write                  | 431034483    | 5666405      | 76.07×  |
| string · read                   | 422908085    | 49990627     | 8.46×   |
| string · write                  | 324317312    | 3912363      | 82.90×  |
| boolean · read                  | 186321054    | 66794690     | 2.79×   |
| boolean · write                 | 928074246    | 5482005      | 169.29× |
| bigint · read                   | 439883343    | 68274905     | 6.44×   |
| bigint · write                  | 976400402    | 5673209      | 172.11× |
| number[] · read index           | 527587553    | 34160776     | 15.44×  |
| number[] · write index          | 239980802    | 3111630      | 77.12×  |
| number[] · push                 | 358166189    | 1866250      | 191.92× |
| number[] · pop                  | 461680517    | 2504696      | 184.33× |
| string[] · read index           | 577480568    | 40440805     | 14.28×  |
| string[] · write index          | 428449015    | 4615378      | 92.83×  |
| string[] · push                 | 352982704    | 3270646      | 107.92× |
| string[] · pop                  | 428449015    | 3234937      | 132.44× |
| boolean[] · read index          | 463768116    | 36171271     | 12.82×  |
| boolean[] · write index         | 342935528    | 4285720      | 80.02×  |
| boolean[] · push                | 311720698    | 3264421      | 95.49×  |
| boolean[] · pop                 | 393545848    | 3337037      | 117.93× |
| bigint[] · read index           | 601051841    | 47644571     | 12.62×  |
| bigint[] · write index          | 444444444    | 5555556      | 80.00×  |
| bigint[] · push                 | 369139904    | 3413936      | 108.13× |
| bigint[] · pop                  | 470588235    | 1184308      | 397.35× |
| mixed[] · read index            | 498338043    | 66828168     | 7.46×   |
| mixed[] · write index           | 369139904    | 4907975      | 75.21×  |
| mixed[] · push                  | 176460208    | 3357113      | 52.56×  |
| mixed[] · pop                   | 386996904    | 3472729      | 111.44× |
| object · read number prop       | 653415402    | 27286991     | 23.95×  |
| object · read string prop       | 626142710    | 29145665     | 21.48×  |
| object · read boolean prop      | 652175331    | 23603232     | 27.63×  |
| object · read bigint prop       | 625978091    | 27205636     | 23.01×  |
| object · write number prop      | 692842247    | 8413201      | 82.35×  |
| object · write string prop      | 369276219    | 5842248      | 63.21×  |
| object · read array prop index  | 600600601    | 15526846     | 38.68×  |
| object · write array prop index | 352858151    | 1725253      | 204.53× |
| object · array prop push        | 119402985    | 2518359      | 47.41×  |
| native vs cached shared read    | 652848050    | 26342999     | 24.78×  |

## Summary

- Reads: 16.1× slower (min 2.8×, max 27.6×)
- Array reads: 16.9× slower (min 7.5×, max 38.7×)
- Writes: 107.7× slower (min 63.2×, max 172.1×)
- Array writes: 126.9× slower (min 47.4×, max 397.4×)
