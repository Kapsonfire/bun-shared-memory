# Benchmark aafac7c

Date: 2026-10-31T14:53:12.798Z

## Results

| Name                            | Native ops/s | Shared ops/s | Ratio   |
| ------------------------------- | ------------ | ------------ | ------- |
| number · read                   | 438196733    | 60575479     | 7.23×   |
| number · write                  | 346320346    | 16587759     | 20.88×  |
| string · read                   | 475059382    | 50217593     | 9.46×   |
| string · write                  | 293392794    | 13958371     | 21.02×  |
| boolean · read                  | 316999410    | 69607587     | 4.55×   |
| boolean · write                 | 909090909    | 14491880     | 62.73×  |
| bigint · read                   | 473092844    | 71466857     | 6.62×   |
| bigint · write                  | 382836667    | 13188770     | 29.03×  |
| number[] · read index           | 628768682    | 35420172     | 17.75×  |
| number[] · write index          | 393545848    | 4509583      | 87.27×  |
| number[] · push                 | 222222222    | 2339411      | 94.99×  |
| number[] · pop                  | 387146729    | 4012036      | 96.50×  |
| string[] · read index           | 596569724    | 40801754     | 14.62×  |
| string[] · write index          | 428632662    | 9320359      | 45.99×  |
| string[] · push                 | 82474227     | 6254887      | 13.19×  |
| string[] · pop                  | 406834825    | 4206099      | 96.72×  |
| boolean[] · read index          | 586795918    | 37986705     | 15.45×  |
| boolean[] · write index         | 380952381    | 9917290      | 38.41×  |
| boolean[] · push                | 129735340    | 6609735      | 19.63×  |
| boolean[] · pop                 | 380952381    | 7968127      | 47.81×  |
| bigint[] · read index           | 506008855    | 42798289     | 11.82×  |
| bigint[] · write index          | 428632662    | 10999043     | 38.97×  |
| bigint[] · push                 | 210526316    | 7036060      | 29.92×  |
| bigint[] · pop                  | 480076812    | 6984850      | 68.73×  |
| mixed[] · read index            | 600900148    | 70675524     | 8.50×   |
| mixed[] · write index           | 436490615    | 11741637     | 37.17×  |
| mixed[] · push                  | 266666667    | 7530574      | 35.41×  |
| mixed[] · pop                   | 421052632    | 2252252      | 186.95× |
| object · read number prop       | 703195320    | 30436388     | 23.10×  |
| object · read string prop       | 638806199    | 26379712     | 24.22×  |
| object · read boolean prop      | 660611065    | 29179326     | 22.64×  |
| object · read bigint prop       | 627616376    | 25940337     | 24.19×  |
| object · write number prop      | 559572039    | 17054419     | 32.81×  |
| object · write string prop      | 413907285    | 11650531     | 35.53×  |
| object · read array prop index  | 534639279    | 15785113     | 33.87×  |
| object · write array prop index | 428449015    | 4499438      | 95.22×  |
| object · array prop push        | 157878118    | 3317663      | 47.59×  |
| native vs cached shared read    | 657516232    | 27931400     | 23.54×  |

## Summary

- Reads: 16.2× slower (min 4.6×, max 24.2×)
- Array reads: 17.0× slower (min 8.5×, max 33.9×)
- Writes: 33.7× slower (min 20.9×, max 62.7×)
- Array writes: 63.6× slower (min 13.2×, max 186.9×)
