# Benchmark aeca1f5

Date: 2026-10-31T14:53:14.009Z

## Results

| Name                            | Native ops/s | Shared ops/s | Ratio   |
| ------------------------------- | ------------ | ------------ | ------- |
| number · read                   | 214688101    | 56074777     | 3.83×   |
| number · write                  | 410325429    | 16867437     | 24.33×  |
| string · read                   | 423056584    | 47010883     | 9.00×   |
| string · write                  | 346320346    | 14104372     | 24.55×  |
| boolean · read                  | 292576458    | 83191769     | 3.52×   |
| boolean · write                 | 927712632    | 15062698     | 61.59×  |
| bigint · read                   | 495766157    | 87225175     | 5.68×   |
| bigint · write                  | 410959467    | 13269859     | 30.97×  |
| number[] · read index           | 549450549    | 34045451     | 16.14×  |
| number[] · write index          | 452898551    | 4735588      | 95.64×  |
| number[] · push                 | 240038406    | 2392104      | 100.35× |
| number[] · pop                  | 421052632    | 3862868      | 109.00× |
| string[] · read index           | 606674634    | 42360909     | 14.32×  |
| string[] · write index          | 436490615    | 8648649      | 50.47×  |
| string[] · push                 | 125643925    | 2263724      | 55.50×  |
| string[] · pop                  | 380952381    | 5216239      | 73.03×  |
| boolean[] · read index          | 499064255    | 39314620     | 12.69×  |
| boolean[] · write index         | 413907285    | 10152284     | 40.77×  |
| boolean[] · push                | 183217296    | 6898550      | 26.56×  |
| boolean[] · pop                 | 375093773    | 8513681      | 44.06×  |
| bigint[] · read index           | 506113855    | 39401103     | 12.85×  |
| bigint[] · write index          | 363636364    | 9966811      | 36.48×  |
| bigint[] · push                 | 214270409    | 6882691      | 31.13×  |
| bigint[] · pop                  | 380952381    | 6739680      | 56.52×  |
| mixed[] · read index            | 569527975    | 69378198     | 8.21×   |
| mixed[] · write index           | 400000000    | 11964012     | 33.43×  |
| mixed[] · push                  | 218197687    | 6825939      | 31.97×  |
| mixed[] · pop                   | 369139904    | 1905216      | 193.75× |
| object · read number prop       | 682011935    | 31525444     | 21.63×  |
| object · read string prop       | 638806199    | 27020031     | 23.64×  |
| object · read boolean prop      | 719854301    | 30162500     | 23.87×  |
| object · read bigint prop       | 627450980    | 26927265     | 23.30×  |
| object · write number prop      | 560352798    | 16130874     | 34.74×  |
| object · write string prop      | 413907285    | 11869436     | 34.87×  |
| object · read array prop index  | 516905391    | 15268633     | 33.85×  |
| object · write array prop index | 413736036    | 4544587      | 91.04×  |
| object · array prop push        | 142025280    | 3413936      | 41.60×  |
| native vs cached shared read    | 642106108    | 26634882     | 24.11×  |

## Summary

- Reads: 15.4× slower (min 3.5×, max 24.1×)
- Array reads: 16.3× slower (min 8.2×, max 33.9×)
- Writes: 35.2× slower (min 24.3×, max 61.6×)
- Array writes: 65.4× slower (min 26.6×, max 193.8×)
